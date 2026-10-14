import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { AccountApiService } from '../auth/account-api.service';
import { AccountDirectoryService } from '../auth/account-directory.service';
import { RolesGuard } from '../auth/roles.guard';
import { NoAudit } from '../audit/audit.interceptor';
import { parseBody } from '../workspace/zod-body';
import { OnboardingService, UserPrefsPatchSchema } from './onboarding.service';

/**
 * `GET /me` — returns the caller's own profile with `isAdmin`.
 * Used by the web client to know whether to show admin-only UI. Also the person's getting started progress and their
 * own UI prefs (tours seen, checklist hidden).
 */
@Controller('me')
@UseGuards(RolesGuard)
export class MeController {
  constructor(
    private readonly accountApi: AccountApiService,
    private readonly directory: AccountDirectoryService,
    private readonly onboarding: OnboardingService,
  ) {}

  /** The getting started checklist: what the caller has done in their teams, and where each step leads. */
  @Get('onboarding')
  getOnboarding(@Req() req: Request) {
    return this.onboarding.progress(req.authContext!.userId);
  }

  @Get('prefs')
  getPrefs(@Req() req: Request) {
    return this.onboarding.prefs(req.authContext!.userId);
  }

  /** Only the fields given change. Not in the activity log: a tour closed is not an action on anything. */
  @Put('prefs')
  @NoAudit()
  updatePrefs(@Body() raw: unknown, @Req() req: Request) {
    return this.onboarding.updatePrefs(req.authContext!.userId, parseBody(UserPrefsPatchSchema, raw));
  }

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
