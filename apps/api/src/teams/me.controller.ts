import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AccountApiService } from '../auth/account-api.service';
import { AccountDirectoryService } from '../auth/account-directory.service';
import { RolesGuard } from '../auth/roles.guard';

/**
 * `GET /me` — returns the caller's own profile with `isAdmin`.
 * Used by the web client to know whether to show admin-only UI.
 */
@Controller('me')
@UseGuards(RolesGuard)
export class MeController {
  constructor(
    private readonly accountApi: AccountApiService,
    private readonly directory: AccountDirectoryService,
  ) {}

  @Get()
  async getMe(@Req() req: Request) {
    const { userId, accessToken, isAdmin } = req.authContext!;

    // If admin flag was already set by RolesGuard use it; otherwise fetch now.
    let admin = isAdmin;
    if (admin === undefined) {
      try {
        const profile = await this.accountApi.getUserProfile(accessToken, userId);
        admin = profile.userType === 'ADMIN';
        req.authContext!.isAdmin = admin;
      } catch {
        admin = false;
      }
    }

    // Name, email, avatar from Account Directory (no-throw: returns empty on failure)
    const summaries = await this.directory.summaries([userId]);
    const profile = summaries.get(userId);

    return {
      userId,
      name: profile?.name ?? null,
      email: profile?.email ?? null,
      avatar: profile?.avatar ?? null,
      isAdmin: admin ?? false,
    };
  }
}
