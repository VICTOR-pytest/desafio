import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { readServerPort } from './infrastructure/config/env';
import { JsonLogger } from './infrastructure/observability/json-logger';
import { NestJsonLogger } from './infrastructure/observability/nest-json-logger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: new NestJsonLogger(new JsonLogger()),
  });

  app.enableShutdownHooks();
  await app.listen(readServerPort());
}
void bootstrap();
