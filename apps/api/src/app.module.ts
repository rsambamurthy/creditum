import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { DatabaseModule } from './database/database.module';
import { AuditService } from './modules/audit/audit.service';
import { ConfigurationService, GovernanceService } from './modules/configuration/configuration.service';
import { FieldRegistryService } from './modules/field-registry/field-registry.service';
import { RulesService } from './modules/rules/rules.service';
import { WorkflowService } from './modules/workflow/workflow.service';
import { CreditRequestService } from './modules/credit-request/credit-request.service';
import { AuthGuard, AuthService } from './modules/auth/auth';
import { FormsService } from './modules/forms/forms.service';
import { ErrorFilter } from './common/errors';
import { runWithContext } from './common/request-context';
import {
  AuditController, AuthController, ConfigController, CreditRequestController, FieldsController, FormulasController, HealthController, LayoutController,
  RulesController, WorkflowController,
} from './modules/controllers';

@Module({
  imports: [DatabaseModule],
  controllers: [HealthController, AuthController, ConfigController, FieldsController, RulesController, WorkflowController, CreditRequestController, AuditController,
    LayoutController, FormulasController],
  providers: [
    AuditService, ConfigurationService, GovernanceService, FieldRegistryService, RulesService, WorkflowService, CreditRequestService, FormsService, AuthService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErrorFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Every request runs inside its own context; the auth guard fills in tenant and actor.
    consumer.apply((req: Request, _res: Response, next: NextFunction) =>
      runWithContext({ ip: req.ip, sessionId: randomUUID() }, () => next())).forRoutes('*');
  }
}
