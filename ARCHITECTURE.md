# Arquitetura

## Camadas

```
src/
  domain/          regras puras, sem NestJS nem MikroORM
  application/     casos de uso e portas (UnitOfWork, repositórios, OutboxStore, EventPublisher)
  infrastructure/  PostgreSQL (SQL via MikroORM), entidades de schema, HTTP, config
```

O domínio não importa o ORM. As entidades MikroORM descrevem o schema (constraints, índices, trigger) e são a fonte das migrations; a leitura e a escrita usam SQL parametrizado dentro da transação do MikroORM, o que torna explícitos `FOR UPDATE`, `SKIP LOCKED` e a precisão de `BIGINT` (valores trafegam como texto, nunca como `number`).

## Domínio

- `Money`: imutável, `bigint` em centavos, entrada somente como string com duas casas, intervalo limitado ao de `BIGINT` do PostgreSQL, operações entre moedas diferentes lançam erro.
- `Wallet`: reidratável (`rehydrate`), `credit`/`debit`, nunca fica negativa; `version` começa em 1 e só aumenta quando o saldo muda (o `OPENING` usa `openWith`, sem alterar a versão).
- `WagerTransaction`: factories `receive` (externa), `opening` (interna), `rehydrate`; máquina de estados com terminais.
- `WalletLedgerEntry`: lançamento com direção explícita (`CREDIT`/`DEBIT`), saldo anterior e posterior validados aritmeticamente.
- `WagerProcessor`: aplica as regras e devolve o lançamento (ou `null`).

## Fluxo de uma operação financeira

1. Valida o comando e o `Idempotency-Key`; calcula o hash do payload.
2. Abre uma transação de banco (`UnitOfWork.run`).
3. (Fila) registra a mensagem no Inbox com `ON CONFLICT DO NOTHING`.
4. `SELECT ... FOR UPDATE` na carteira (`walletId` quando informado; senão `(playerId, currency)`): serializa operações da mesma carteira sem lock global.
5. Procura a transação por chave de idempotência e por identidade externa: hash igual devolve a **resposta original** (snapshot persistido); hash diferente lança conflito.
6. Carrega a referência (se `REFUND`/`ROLLBACK`) e verifica se já foi revertida **pelo mesmo tipo**.
7. Executa o domínio.
8. Persiste, na mesma transação: transação (com o snapshot da resposta), lançamento, saldo e versão (`UPDATE ... WHERE version = esperada`), eventos do Outbox e vínculo do Inbox.
9. `COMMIT`. Qualquer falha reverte tudo. Na fila, a mensagem só é confirmada depois do commit.

Se duas requisições passarem juntas pelo passo 5 (por exemplo, carteira inexistente, onde não há linha a travar), a constraint `UNIQUE` rejeita a segunda; o erro vira `RetryableError` e a operação é repetida até 3 vezes, caindo então no replay. Deadlocks e timeouts de lock seguem o mesmo caminho.

## Garantias no banco

| Garantia | Mecanismo |
|---|---|
| uma carteira por jogador e moeda | `UNIQUE (player_id, currency)` |
| identidade externa e idempotência | `UNIQUE (provider, external_transaction_id)` e `UNIQUE (provider, idempotency_key)` |
| um lançamento por transação e carteira | `UNIQUE (wallet_id, transaction_id)` |
| ledger imutável | trigger `BEFORE UPDATE OR DELETE` |
| saldo não negativo | `CHECK` em `wallets` e em `wallet_ledger_entries` |
| aritmética do lançamento | `CHECK` de coerência entre direção, valor e saldos |
| reversão única por referência **e por tipo** | índice único parcial em `(reference_transaction_id, type)` com `status = 'PROCESSED'` e tipo `REFUND`/`ROLLBACK` |
| versão da carteira ≥ 1; lost update | `CHECK (version >= 1)` e `UPDATE ... WHERE version = esperada` sob `FOR UPDATE` |
| ordem estável do ledger | coluna `sequence` (`bigserial`) indexada por carteira |
| estados e tipos válidos, `failure_code` e `processed_at` consistentes | `CHECK` |
| integridade referencial | FKs com `ON DELETE RESTRICT` |
| `Inbox` sem duplicidade | `UNIQUE (source, message_id)` |

O trigger de `TRUNCATE` foi omitido porque o MikroORM não o reconhece na introspecção e acusaria divergência permanente (os testes limpam dados com `TRUNCATE`).

## Outbox, Inbox e SQS

Eventos (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WalletBalanceChanged`) são gravados na mesma transação do efeito financeiro e nunca existem antes do commit. Cada linha guarda `correlation_id` e `causation_id`; ao publicar, `toIntegrationEvent` monta o envelope `{ eventId, eventType, aggregateId, correlationId, causationId?, occurredAt, version, data }`.

`OutboxPublisher` reivindica lotes com `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`, incrementa `attempts`, define um lease (`locked_until`) e publica via a porta `EventPublisher` (adaptador `SqsEventPublisher`, `MessageGroupId` = agregado, `MessageDeduplicationId` = `eventId`). Em falha aplica backoff exponencial limitado e **mantém o evento pendente**: por padrão não há limite de tentativas, então nada confirmado é descartado em silêncio; `FAILED` só ocorre se `maxAttempts` for configurado, e é registrado em log e métrica. Um publicador que caiu é recuperado quando o lease expira. A entrega é *at-least-once*; consumidores devem deduplicar por `eventId`.

`SqsWagerConsumer` usa o mesmo `ProcessWagerTransactionUseCase` do HTTP. Parser e política: JSON ou atributos inválidos, `providerId` divergente do atributo, campos inválidos e conflito de idempotência são **permanentes** (enviados à DLQ com `failureReason` e removidos); rejeição de negócio é **terminal** (persistida e confirmada); qualquer outro erro é **transitório** (`ChangeMessageVisibility` com backoff; o `RedrivePolicy` da fila move para a DLQ ao esgotar `maxReceiveCount`). O Inbox usa `(source = consumerName, message_id)`.

## Workers

Todos são opcionais (flags `WORKER_*`) e iniciados/encerrados por `WorkersLifecycle` (`onApplicationBootstrap` / `beforeApplicationShutdown`, acionado por `enableShutdownHooks`): consumidor SQS, publicador do Outbox, resolvedor de referências pendentes e reconciliação periódica. No encerramento, o consumidor para de receber, conclui a mensagem em andamento e só então a aplicação termina.

O resolvedor de `PENDING_REFERENCE` reivindica itens vencidos com lease (`SKIP LOCKED`), trava a carteira e depois a transação, reaplica todas as regras do domínio e, se ainda faltar a referência, agenda nova tentativa com backoff exponencial. Ao passar de `pending_expires_at` ou de `PENDING_REFERENCE_MAX_ATTEMPTS`, a transação vira `REJECTED` com `PENDING_REFERENCE_EXPIRED` e emite `WagerTransactionRejected`. Resolver não duplica saldo, lançamento nem eventos (a transição é feita sob o lock da carteira e a transação deixa de ser pendente).

## Reconciliação

`POST /wallets/:id/reconciliation` e o worker periódico comparam, em **um único comando SQL** (leitura consistente), `wallets.balance_in_cents` com a soma assinada do ledger. Divergências são gravadas em `reconciliation_discrepancies` (sem duplicar a mesma divergência) e registradas em log de erro e métrica; o saldo **nunca** é corrigido.

## Observabilidade

Logs JSON (uma linha por evento, campos de correlação, chaves sensíveis redigidas, valores monetários nunca logados). `GET /metrics` expõe contadores, histograma de latência do processamento e o gauge `outbox_lag_seconds`. `GET /health/live` não depende de nada; `GET /health/ready` consulta PostgreSQL e SQS (503 se algum estiver indisponível).

## Interpretações e decisões

O documento original do desafio não esteve disponível; as regras seguem os enunciados das Sprints 3 e 4. Itens a revisar:

- Reversão única **por tipo** (texto da seção 7 citado no enunciado): um `REFUND` e um `ROLLBACK` processados sobre a mesma `BET` são permitidos.
- `ROLLBACK` referencia `BET`, `WIN` ou `REFUND`; `REFUND` somente `BET`.
- Formato do contrato HTTP inferido: `providerId`/`provider`, valor em objeto ou em campos separados, `walletId` opcional (valida jogador e moeda da carteira).
- Rejeições de negócio são persistidas como `REJECTED` com `failureCode` e respondidas com 422; só erros inesperados abortam sem registro. `FAILED` existe no domínio e no schema, mas nenhum fluxo o produz.
- Carteira inexistente gera `REJECTED` com `WALLET_NOT_FOUND`; o `OPENING` só ocorre por `POST /wallets`, emite só `WalletBalanceChanged` e somente com saldo inicial positivo.
- `wager-events.fifo` como destino dos eventos do Outbox é suposição.
- Provedor interno do `OPENING`: `SYSTEM`.

## Autenticação

Não implementada, conforme o escopo. Ponto de extensão: registrar um guard global (`APP_GUARD`) em `AppModule` e, para o provider, derivá-lo da identidade autenticada em vez do corpo da requisição.

## Pendências

- Executar `docker compose up` e validar a imagem `postgres:17-alpine`: **feito** (Compose em execução; o teste de reinício do PostgreSQL usa `docker stop`/`docker start` no container correto). SIGTERM real também foi validado manualmente (`stopping workers` → `workers stopped`).
- Rodar três processos distintos e `kill` de um worker; hoje isso é coberto por `app.close()`, três aplicações no mesmo processo e um gancho antes do ack.
- Reinício do LocalStack (as filas dele não persistem; o consumidor não recria filas em execução).
- Histograma de latência do consumidor SQS e do publicador; tracing distribuído.
- Conferir o texto original do desafio (formatos e códigos HTTP).
