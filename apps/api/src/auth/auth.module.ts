import { Global, Module } from '@nestjs/common';
import { Auth0Guard } from './auth0.guard';
import { RolesGuard } from './roles.guard';
import { TicketGuard } from './ticket.guard';
import { AccountApiService } from './account-api.service';
import { AccountDirectoryService } from './account-directory.service';
import { StudioAdminService } from './studio-admin.service';

@Global()
@Module({
  providers: [Auth0Guard, RolesGuard, TicketGuard, AccountApiService, AccountDirectoryService, StudioAdminService],
  exports: [Auth0Guard, RolesGuard, TicketGuard, AccountApiService, AccountDirectoryService, StudioAdminService],
})
export class AuthModule {}
