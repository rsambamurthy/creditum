import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Env, loadEnv } from '../config/env';
import { createDataSource } from './data-source';

export const ENV = 'ENV';

@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: () => loadEnv() },
    {
      provide: DataSource,
      inject: [ENV],
      useFactory: async (env: Env) => {
        const ds = createDataSource(env);
        await ds.initialize();
        if (env.migrateOnStart) {
          const ran = await ds.runMigrations();
          new Logger('Database').log(`Migrations applied: ${ran.length}`);
        }
        return ds;
      },
    },
  ],
  exports: [ENV, DataSource],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DataSource) private readonly ds: DataSource) {}
  async onApplicationShutdown() {
    if (this.ds.isInitialized) await this.ds.destroy();
  }
}
