# Matriz de conformidade — Sprint 4

**Fonte dos requisitos.** O documento original `Technical Challenge — Distributed Wagering Processor` **não esteve disponível** em nenhuma sessão de desenvolvimento. Esta matriz foi montada a partir do enunciado da Sprint 4 (que cita partes do desafio, como a seção 7 e o contrato de criação de carteira) e das Sprints 2 e 3. Itens marcados com † dependem de formato ou texto do desafio que não pôde ser conferido literalmente.

Estados: **conforme** (código + teste executado), **parcial**, **ausente**, **divergente**, **não validado** (implementado, mas sem execução real do ambiente exigido).

Ambiente de validação: Bun 1.4.2; PostgreSQL 17 na imagem Docker `postgres:17-alpine` do próprio Compose (container `jungle-wagering-postgres`, porta 127.0.0.1:5433); LocalStack 4 na imagem `localstack/localstack:4` do Compose (container `jungle-wagering-localstack`, porta 127.0.0.1:4566). `docker compose config` valida o YAML e os dois serviços sobem com `docker compose up -d` (executado neste ambiente; filas criadas por `docker/localstack/init-queues.sh`, `RedrivePolicy` confirmada).

## Fase 1 — Domínio e persistência

| Requisito | Estado | Arquivos | Teste que comprova |
|---|---|---|---|
| Reversão: uma referência não pode ser revertida duas vezes **pelo mesmo tipo** (seção 7) | conforme † | `wager-processor.ts`, `postgres-wager-transaction.repository.ts` (`isReversed(ref, type)`), migration `conformance` (índice `wager_transactions_single_reversal_per_type_unique`) | `financial-core` (REFUND/ROLLBACK independentes; concorrência por tipo), `constraints` (índice parcial), `wager-processor.spec` |
| `REFUND` só referencia `BET`; `ROLLBACK` referencia `BET`, `WIN` ou `REFUND` | conforme | `wager-processor.ts` | `wager-processor.spec` (matriz de tipos) |
| Referência não processada; divergência de provedor, jogador, carteira, moeda, rodada, valor; saldo negativo | conforme | `wager-processor.ts` | `wager-processor.spec`, `financial-core` |
| Versão da carteira começa em 1 e só aumenta quando o saldo muda | conforme | `wallet.ts`, `wallet.entity.ts`, `postgres-wallet.repository.ts`, migration `conformance` | `wallet.spec`, `versioning-replay` (incl. 40 BETs concorrentes) |
| Proteção contra lost update | conforme | `saveBalance(wallet, expectedVersion)` + `FOR UPDATE` | `versioning-replay` (versão desatualizada falha sem alterar o saldo) |
| Replay devolve o resultado original, com saldo e versão observados na época | conforme | `process-wager-transaction.use-case.ts`, coluna `response_snapshot` | `versioning-replay` (replay com saldo original, de rejeição e de pendência) |
| Campo de resposta `idempotentReplay` | conforme | `ProcessWagerResult` | `versioning-replay`, `contract.e2e` |
| Mesma chave com payload divergente = conflito; replay sem novo débito, crédito, lançamento ou evento | conforme | idem | `versioning-replay`, `financial-core` |

## Fase 2 — API

| Requisito | Estado | Arquivos | Teste |
|---|---|---|---|
| `POST /wallets` com `{ playerId, initialBalance: { amount, currency } }`, resposta com id, jogador, saldo e versão | conforme † | `wallets.controller.ts`, `request-parsers.ts` | `contract.e2e` |
| `GET /wallets/:walletId` | conforme | idem | `contract.e2e` |
| `GET /wallets/:walletId/ledger?cursor&limit=50` com cursor estável e opaco | conforme | `get-ledger.use-case.ts`, coluna `sequence` | `ledger-reconciliation`, `contract.e2e` |
| `GET /wagering/transactions/:transactionId` | conforme | `wager-transactions.controller.ts` | `contract.e2e` |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | conforme | idem | `contract.e2e` |
| `POST /wagering/transactions` com `Idempotency-Key` obrigatório | conforme † | idem | `contract.e2e` |
| `POST /wallets/:walletId/reconciliation` (compara, registra, nunca corrige) | conforme | `reconcile-wallet.use-case.ts`, tabela `reconciliation_discrepancies` | `ledger-reconciliation`, `contract.e2e` |
| `GET /health/live` e `GET /health/ready` (PostgreSQL e SQS) | conforme | `health.controller.ts` | `contract.e2e`, `restart.e2e` |
| Formato exato de request/response, estados, códigos de falha e mapeamento HTTP do desafio | **parcial** † | — | O formato foi inferido do enunciado: valor como `{amount,currency}` (ou campos separados), `providerId` (ou `provider`), `walletId` opcional; HTTP 201/200/202/422/400/409/404/503 |
| Rotas anteriores (`/wager-transactions`, `/wallets/:playerId/:currency`) mantidas | conforme | `LegacyWagerTransactionsController` | `api.e2e`, `contract.e2e` |

## Fase 3 — SQS e LocalStack

| Requisito | Estado | Arquivos | Teste |
|---|---|---|---|
| PostgreSQL 17, LocalStack, fila FIFO `wager-transactions.fifo` e DLQ FIFO no Compose | conforme | `docker-compose.yml`, `docker/localstack/init-queues.sh` | `docker compose config` aceito; `docker compose up -d` em execução neste ambiente (containers `jungle-wagering-postgres` = `postgres:17-alpine` e `jungle-wagering-localstack` = `localstack/localstack:4`, ambos healthy); filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (com `RedrivePolicy`) e `wager-events.fifo` presentes no LocalStack |
| Consumidor e publicador SQS | conforme | `sqs-wager-consumer.ts`, `sqs-event-publisher.ts` | `sqs.integration` |
| Mesma regra de negócio do HTTP | conforme | ambos chamam `ProcessWagerTransactionUseCase` | `sqs.integration` |
| Inbox com deduplicação por `(consumerName, messageId)` | conforme | `UNIQUE (source, message_id)` | `constraints`, `sqs.integration` |
| Inbox, transação, saldo, ledger e Outbox na mesma transação SQL | conforme | `handle()` do use case | `financial-core` (falha injetada em outbox, ledger e saldo) |
| Ack somente depois do commit | conforme | consumer | `sqs.integration` (saldo já gravado quando o ack é chamado; crash antes do ack) |
| Rejeição de negócio é terminal | conforme | consumer | `sqs.integration` |
| Falha transitória com retry e backoff | conforme | `retryLater` (`ChangeMessageVisibility`) | `sqs.integration` |
| Falha permanente → DLQ; tentativas esgotadas → DLQ | conforme | consumer + `RedrivePolicy` | `sqs.integration` (7 causas permanentes + redrive após `maxReceiveCount`) |
| Encerramento gracioso em SIGTERM | conforme | `workers.lifecycle.ts`, `main.ts` (`enableShutdownHooks`) | Sinal SIGTERM de SO enviado ao processo real (`bun dist/main.js`): logs `stopping workers` (com `signal: SIGTERM`) e `workers stopped` antes da saída, processo encerrado sem resíduo. Também coberto por `consumer.stop()` e `app.close()` nos testes |
| Redelivery sem duplicar efeitos | conforme | idempotência no PostgreSQL | `sqs.integration` |
| Identidade do provedor validada na fila | conforme | `sqs-message-parser.ts` | `sqs-message-parser.spec`, `sqs.integration` |

## Fase 4 — Outbox e referências pendentes

| Requisito | Estado | Arquivos | Teste |
|---|---|---|---|
| Publicação periódica integrada ao módulo | conforme | `app.module.ts`, `interval-worker.ts` | `workers.e2e` |
| Publishers concorrentes, lease recuperável, backoff exponencial limitado | conforme | `postgres-outbox.repository.ts` (`SKIP LOCKED`), `outbox-publisher.ts` | `outbox.integration`, `sqs.integration` |
| Commit seguido de queda antes da publicação | conforme | idem | `sqs.integration` |
| Falha não descarta evento confirmado | conforme | tentativas ilimitadas por padrão; `FAILED` só se `maxAttempts` for configurado | `sqs.integration`, `outbox.integration` |
| Envelope `IntegrationEvent` | conforme | `events.ts` | `sqs.integration` |
| Eventos Processed/Rejected/PendingReference/BalanceChanged nos momentos corretos | conforme † | `events.ts`, use cases | `financial-core`, `pending-reference` |
| Worker de `PENDING_REFERENCE` (backoff, tentativas e TTL, concorrência, expiração terminal com código e evento) | conforme | `resolve-pending-references.use-case.ts`, `postgres-pending-reference.store.ts` | `pending-reference.integration`, `workers.e2e` |

## Fase 5 — Observabilidade

| Requisito | Estado | Arquivos | Teste |
|---|---|---|---|
| Logs JSON com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` | conforme | `json-logger.ts` | `metrics.spec`, `contract.e2e` |
| Sem segredos nem payloads financeiros completos | conforme | redação de chaves sensíveis; valores nunca logados | `metrics.spec`, `contract.e2e` |
| Métricas: estado, duplicidade, retries, DLQ, conflito de lock, latência, atraso do Outbox | conforme | `metrics.ts`, `GET /metrics` | `contract.e2e`, `financial-core`, `workers.e2e` |
| Reconciliação periódica | conforme | `reconcile-all-wallets.use-case.ts` | `ledger-reconciliation`, `workers.e2e` |

A latência medida é a do processamento da transação; não há histograma de latência do consumidor SQS nem do publicador.

## Fase 6 — Testes obrigatórios

| # | Cenário | Estado | Evidência |
|---|---|---|---|
| 1 | 50 submissões paralelas | conforme | `financial-core`, `multi-instance.e2e` |
| 2 | Duas apostas de 80.00 sobre 100.00 | conforme | idem |
| 3 | Carteiras diferentes em paralelo | conforme | `multi-instance.e2e` (30 carteiras) |
| 4 | Três instâncias da aplicação | **parcial** | Três aplicações Nest, cada uma com seu pool, no **mesmo processo de SO**; não são três processos ou contêineres |
| 5 | Worker morto após commit e antes do ack | **parcial** | Simulado por um gancho que interrompe antes do ack; nenhum `kill` de processo |
| 6 | Dois publishers concorrentes | conforme | `outbox.integration`, `sqs.integration` |
| 7 | Reversão antes da referência | conforme | `pending-reference`, `workers.e2e` |
| 8 | Reinicialização dos serviços | conforme | PostgreSQL derrubado e religado de verdade com `docker stop`/`docker start` no container do Compose (`restart.e2e`, executado com `PG_STOP_CMD`/`PG_START_CMD`); readiness acusa a queda (503, `checks.postgres: down`), mensagem enviada durante a parada não se perde e a aplicação se recupera sozinha. Reinício do LocalStack **não** testado (as filas dele não persistem) |
| 9 | Integridade e imutabilidade do ledger | conforme | `constraints`, `ledger-reconciliation` |
| 10 | Reconciliação de saldo | conforme | `ledger-reconciliation` |
| 11 | Replay com snapshot original | conforme | `versioning-replay` |
| 12 | Constraints e migrations no PostgreSQL 17 | conforme | PostgreSQL 17 na imagem `postgres:17-alpine` do Compose (a mesma do `docker-compose.yml`); `bun run schema:check` = `Schema is up-to-date`, `migration:pending` = `No pending migrations` |
| 13 | Retries, DLQ e duplicatas no SQS | conforme | `sqs.integration` |

Propriedade central (saldo = saldo reconstruído pelo ledger, e versão = 1 + lançamentos não-OPENING): verificada ao final de `multi-instance.e2e`, em `ledger-reconciliation` e em `financial-core`.

## Resultados dos comandos (execução final)

| Comando | Resultado |
|---|---|
| `bun install --frozen-lockfile` | exit 0 |
| `bun run build` | exit 0 |
| `bun run lint` | exit 0, 0 erros e 0 warnings |
| `bun run test` | 166 passam, 0 falham |
| `bun run test:integration` | 128 passam, 0 falham (3 execuções) |
| `bun run test:e2e` | 58 passam, 0 falham (com o cenário de reinício do PostgreSQL habilitado via `PG_STOP_CMD`/`PG_START_CMD`) |
| `bun run test:all` | 351 passam, 3 ignorados (cenário de reinício sem os comandos), 0 falham |
| `bun run schema:check` | `Schema is up-to-date` |
| `bun run migration:pending` | `No pending migrations` |
| `docker compose config` / `docker compose up -d` | exit 0; `jungle-wagering-postgres` (`postgres:17-alpine`) e `jungle-wagering-localstack` (`localstack/localstack:4`) no ar e healthy |
| SIGTERM real (`kill -TERM` em `bun dist/main.js`) | logs `stopping workers` → `workers stopped`; processo encerra sem resíduo |

## Pendências e decisões para revisão

1. Ler o desafio original e conferir as marcas †.
2. A unicidade de reversão por tipo permite, literalmente, um `REFUND` **e** um `ROLLBACK` processados sobre a mesma `BET` (dois créditos). Segue o texto citado da seção 7; a regra mais forte foi rejeitada por instrução. Precisa de confirmação de negócio.
3. A fila `wager-events.fifo` (destino dos eventos do Outbox) foi uma suposição; o enunciado só nomeia a fila de entrada e a DLQ.
4. `OPENING` emite apenas `WalletBalanceChanged` (e só com saldo inicial positivo); não emite `WagerTransactionProcessed`.
5. `FAILED` continua existindo no domínio e no schema, mas nenhum fluxo o produz.
6. A coluna `sequence` do ledger, em linhas anteriores à migration, recebeu valores em ordem física, não cronológica.
7. Três processos distintos (não três aplicações no mesmo processo) e o reinício do LocalStack permanecem não exercitados; o SIGTERM real e a imagem `postgres:17-alpine` já foram exercitados (ver acima).
8. Não há autenticação (ponto de extensão documentado em `ARCHITECTURE.md`).
