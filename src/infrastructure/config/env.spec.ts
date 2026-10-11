import { readDatabaseSettings, readServerPort } from './env';

describe('readDatabaseSettings', () => {
  it('aplica os valores padrão quando só a senha é informada', () => {
    expect(readDatabaseSettings({ DB_PASSWORD: 'senha-local' })).toEqual({
      host: '127.0.0.1',
      port: 5433,
      dbName: 'jungle_wagering',
      user: 'jungle_app',
      password: 'senha-local',
    });
  });

  it('usa os valores informados no ambiente', () => {
    expect(
      readDatabaseSettings({
        DB_HOST: 'db.interno',
        DB_PORT: '6000',
        DB_NAME: 'outro_banco',
        DB_USER: 'outro_usuario',
        DB_PASSWORD: 'senha-local',
      }),
    ).toEqual({
      host: 'db.interno',
      port: 6000,
      dbName: 'outro_banco',
      user: 'outro_usuario',
      password: 'senha-local',
    });
  });

  it('rejeita ambiente sem senha', () => {
    expect(() => readDatabaseSettings({})).toThrow('DB_PASSWORD é obrigatória');
  });

  it.each(['abc', '0', '65536', '-1', '54.3'])(
    'rejeita DB_PORT inválida (%s)',
    (port) => {
      expect(() =>
        readDatabaseSettings({ DB_PASSWORD: 'senha-local', DB_PORT: port }),
      ).toThrow('DB_PORT deve ser uma porta TCP válida');
    },
  );

  it('não revela a senha nas mensagens de erro', () => {
    let error: unknown;

    try {
      readDatabaseSettings({ DB_PASSWORD: 'segredo-123', DB_PORT: 'x' });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('segredo-123');
  });
});

describe('readServerPort', () => {
  it('usa 3001 quando PORT não é informada', () => {
    expect(readServerPort({})).toBe(3001);
  });

  it('usa PORT quando informada', () => {
    expect(readServerPort({ PORT: '4000' })).toBe(4000);
  });

  it('rejeita PORT inválida', () => {
    expect(() => readServerPort({ PORT: 'oi' })).toThrow(
      'PORT deve ser uma porta TCP válida',
    );
  });
});
