# Jungle Wagering Backend

Backend NestJS que processa eventos de aposta (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) sobre carteiras multimoeda, com saldo exato, ledger imutável, versão da carteira, idempotência persistente, Inbox/Outbox transacionais, consumo e publicação via SQS FIFO e reconciliação.

A conformidade com o desafio, com o estado de cada requisito e as pendências, está em [`docs/CONFORMANCE-MATRIX.md`](docs/CONFORMANCE-MATRIX.md). A arquitetura está em [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Stack

Bun 1.x (runtime, gerenciador de pacotes e test runner), TypeScript estrito, NestJS 12, MikroORM 7, PostgreSQL 17, AWS SQS (LocalStack). Validado com Bun 1.4.2, PostgreSQL 17.10 e LocalStack 2026.3.0.

## Executar localmente

```bash
cp .env.example .env             # defina DB_PASSWORD
docker compose up -d             # PostgreSQL 17 + LocalStack com as filas FIFO e a DLQ
bun install
bun run migration:up
bun run start:dev                # http://127.0.0.1:3001
```

`docker compose up` cria `wager-transactions.fifo`, `wager-transactions-dlq.fifo` (com `RedrivePolicy`) e `wager-events.fifo` por `docker/localstack/init-queues.sh`. Sem Docker, qualquer PostgreSQL 17 e um endpoint SQS compatível funcionam; use `SQS_AUTO_CREATE_QUEUES=true` para criar as filas na inicialização.

### Variáveis de ambiente

| Variável | Padrão | Uso |
|---|---|---|
| `DB_PASSWORD` | obrigatória | senha do PostgreSQL |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` | `127.0.0.1`, `5433`, `jungle_wagering`, `jungle_app` | conexão |
| `PORT` | `3001` | porta HTTP |
| `TEST_DB_NAME` | obrigatória nos testes de integração e e2e | banco de teste; deve terminar em `_test` |
| `SQS_ENABLED` | `false` | habilita SQS (readiness, consumidor, publicador) |
| `SQS_ENDPOINT`, `AWS_REGION` | — , `us-east-1` | endpoint (LocalStack) e região; credenciais pela cadeia padrão da AWS |
| `SQS_WAGER_QUEUE`, `SQS_WAGER_DLQ`, `SQS_EVENTS_QUEUE` | `wager-transactions.fifo`, `wager-transactions-dlq.fifo`, `wager-events.fifo` | filas |
| `SQS_AUTO_CREATE_QUEUES` | `false` | cria as filas ausentes na inicialização |
| `SQS_MAX_RECEIVE_COUNT`, `SQS_VISIBILITY_TIMEOUT_SECONDS`, `SQS_WAIT_TIME_SECONDS` | `5`, `30`, `10` | política da fila |
| `SQS_RETRY_BASE_SECONDS`, `SQS_RETRY_MAX_SECONDS` | `2`, `300` | backoff das falhas transitórias |
| `WORKER_SQS_CONSUMER`, `WORKER_OUTBOX_PUBLISHER`, `WORKER_PENDING_REFERENCES`, `WORKER_RECONCILIATION` | `false` | liga cada worker |
| `OUTBOX_POLL_INTERVAL_MS`, `PENDING_REFERENCE_INTERVAL_MS`, `RECONCILIATION_INTERVAL_MS` | `1000`, `5000`, `300000` | intervalos |
| `PENDING_REFERENCE_TTL_MS`, `PENDING_REFERENCE_MAX_ATTEMPTS`, `PENDING_REFERENCE_BASE_BACKOFF_MS` | `86400000`, `50`, `1000` | política das referências pendentes |

Nenhum segredo é versionado; `.env` está no `.gitignore`. Os valores `AWS_ACCESS_KEY_ID=test` do `.env.example` valem apenas para o LocalStack.

## Migrations

```bash
bun run migration:pending
bun run migration:up
bun run migration:down   # reverte somente a última migration
bun run schema:check     # "Schema is up-to-date" quando entidades e banco coincidem
```

As migrations são aditivas e reversíveis. A migration `conformance` adiciona a versão da carteira, o índice de reversão por tipo (substituindo o anterior), a sequência do ledger, o snapshot de replay, os metadados de pendência, as colunas de correlação do Outbox e a tabela `reconciliation_discrepancies`; o `down` remove apenas esses objetos.

## Testes

Os testes de integração e e2e **apagam e recriam o schema `public`** de `TEST_DB_NAME`. Use um banco descartável dedicado, um endpoint SQS real (`SQS_ENDPOINT`) e credenciais de teste:

```bash
createdb jungle_wagering_test
export TEST_DB_NAME=jungle_wagering_test SQS_ENDPOINT=http://127.0.0.1:4566 AWS_REGION=us-east-1

bun run test               # unitários (src/)
bun run test:integration   # PostgreSQL e SQS reais
bun run test:e2e           # HTTP, três instâncias, workers e SQS reais
bun run test:cov           # unitários com cobertura
bun run build && bun run lint && bun run schema:check
```

Cenário opcional de reinício do PostgreSQL (ativado apenas quando os comandos são informados). Com o stack do Compose, os comandos seguros são `docker stop`/`docker start` **apenas** do container `jungle-wagering-postgres` (identificado pelo mapeamento 127.0.0.1:5433 do `.env`):

```bash
PG_STOP_CMD="docker stop --time 15 jungle-wagering-postgres" \
PG_START_CMD="docker start jungle-wagering-postgres" \
bun run test:e2e
```

## API

Autenticação não está implementada; não exponha o serviço publicamente sem ela (ver `ARCHITECTURE.md`). Valores monetários trafegam como string decimal com exatamente duas casas; números JSON, notação científica, escala diferente de duas casas e valores negativos são rejeitados com 400.

| Rota | Descrição |
|---|---|
| `POST /wallets` | abre a carteira e registra o `OPENING`. Corpo: `{ playerId, initialBalance: { amount, currency } }` (o formato `{ playerId, currency, openingBalance }` continua aceito) |
| `GET /wallets/:walletId` | carteira com saldo e `version` |
| `GET /wallets/:walletId/ledger?cursor=&limit=50` | lançamentos em ordem, `limit` de 1 a 200, `nextCursor` opaco |
| `POST /wallets/:walletId/reconciliation` | compara o saldo materializado com o reconstruído pelo ledger; registra a divergência e nunca corrige o saldo |
| `POST /wagering/transactions` | processa um evento; cabeçalho `Idempotency-Key` obrigatório; `X-Correlation-Id` opcional |
| `GET /wagering/transactions/:transactionId` | estado atual da transação |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | idem, por identidade externa |
| `GET /health/live`, `GET /health/ready` | liveness; readiness (PostgreSQL e SQS) |
| `GET /metrics` | métricas em formato Prometheus |

Rotas anteriores mantidas: `POST /wager-transactions`, `GET /wallets/:playerId/:currency`, `GET /health`.

Corpo de `POST /wagering/transactions` (o valor também pode vir em `amount` + `currency` e o provedor em `provider`):

```json
{
  "providerId": "provider-1",
  "externalTransactionId": "ext-1",
  "playerId": "player-1",
  "walletId": "opcional",
  "roundId": "round-1",
  "type": "BET",
  "amount": { "amount": "10.00", "currency": "BRL" },
  "referenceExternalTransactionId": "ext-0"
}
```

Resposta: `{ transactionId, status, failureCode, idempotentReplay, wallet: { walletId, balance, version } | null }`.

| Status HTTP | Situação |
|---|---|
| 201 | processada (primeira vez) |
| 200 | replay de uma transação processada |
| 202 | `PENDING_REFERENCE` |
| 422 | rejeitada (`failureCode` no corpo), inclusive em replays |
| 400 | entrada inválida ou `Idempotency-Key` ausente |
| 409 | mesma chave ou identidade externa com payload diferente |
| 404 | recurso inexistente (ids que não são UUID também resultam em 404) |
| 503 | conflito transitório esgotou as tentativas; reenviar com a mesma chave |

## Fila (SQS)

Mensagens em `wager-transactions.fifo` usam o mesmo corpo do HTTP, mais `idempotencyKey` e `correlationId` opcionais, e o atributo de mensagem **`providerId`**, que deve coincidir com o corpo. Recomenda-se `MessageGroupId` = `playerId`.

- Sucesso e rejeição de negócio: a mensagem é confirmada **depois** do commit.
- Falha permanente (JSON inválido, atributo ausente ou divergente, campo inválido, conflito de idempotência): vai direto para a DLQ com o atributo `failureReason`.
- Falha transitória: a mensagem volta com backoff (`ChangeMessageVisibility`); ao exceder `SQS_MAX_RECEIVE_COUNT`, o SQS a move para a DLQ.
- Os eventos do Outbox são publicados em `wager-events.fifo` como `IntegrationEvent` `{ eventId, eventType, aggregateId, correlationId, causationId?, occurredAt, version, data }`, com `MessageDeduplicationId` = `eventId`.

## Regras de domínio

- `BET` debita e é rejeitada com `INSUFFICIENT_FUNDS` se o saldo não cobre. `WIN` credita. `LOSS` registra o resultado sem lançamento.
- `REFUND` credita o valor de uma `BET` processada. `ROLLBACK` inverte uma `BET` (crédito), `WIN` ou `REFUND` (débito). Uma referência **não pode ser revertida duas vezes pelo mesmo tipo de reversão** (seção 7 do desafio); `REFUND` e `ROLLBACK` são, portanto, independentes entre si.
- A referência é validada quanto a provedor, jogador, moeda, carteira, rodada, tipo, estado e valor (igual). Reversão que deixaria o saldo negativo é rejeitada com `ROLLBACK_NEGATIVE_BALANCE`.
- Estados: `PENDING`, `PENDING_REFERENCE`, `PROCESSED`, `REJECTED`, `FAILED`; os três últimos são terminais. Uma reversão cuja referência ainda não existe fica `PENDING_REFERENCE` e é retomada por um worker; ao expirar, vira `REJECTED` com `PENDING_REFERENCE_EXPIRED`.
- A versão da carteira começa em 1 e aumenta uma unidade a cada alteração real do saldo. `LOSS`, rejeições, pendências e replays não a alteram.
- `OPENING` é interno e nunca é aceito como entrada externa.

## Idempotência

A identidade de negócio é `(provider, externalTransactionId)` e a chave é `(provider, Idempotency-Key)`; ambas são `UNIQUE` no banco. O hash SHA-256 do JSON canônico de `provider`, `externalTransactionId`, `playerId`, `walletId` (quando informado), `roundId`, `type`, `amount`, `currency` e `referenceExternalTransactionId` decide:

- mesma chave, mesmo hash: devolve a resposta **original** (inclusive o saldo e a versão da época), com `idempotentReplay: true`, sem novo efeito;
- mesma chave ou mesma identidade externa, hash diferente: 409 (ou DLQ, na fila).

## Limitações conhecidas

Veja "Pendências e decisões para revisão" em `docs/CONFORMANCE-MATRIX.md`. Em especial: o texto original do desafio não foi lido; três processos distintos (não três aplicações no mesmo processo), o reinício do LocalStack e o cenário de SIGTERM automatizado não foram exercitados (o SIGTERM real foi validado manualmente); não há autenticação.
