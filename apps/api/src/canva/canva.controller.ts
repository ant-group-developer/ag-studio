import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Query, Req, Res } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Request, Response } from 'express';
import { Public } from '../auth/public.decorator';
import { CanvaService } from './canva.service';

class AuthorizeDto {
  /** Where the web app wants the user back (a path of the app, e.g. the episode they were on). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  returnTo?: string;
}

/**
 * The caller's own Canva connection (docs/studio-api-v3.md "Canva"). The thumbnail routes (open in Canva, bring it
 * back) are with the other thumbnail routes.
 */
@Controller('canva')
export class CanvaController {
  constructor(private readonly canva: CanvaService) {}

  @Get('connection')
  connection(@Req() req: Request) {
    return this.canva.connection(req.authContext!.userId);
  }

  @Post('authorize')
  @HttpCode(HttpStatus.OK)
  authorize(@Body() dto: AuthorizeDto, @Req() req: Request) {
    return { authorizeUrl: this.canva.authorize(req.authContext!.userId, dto.returnTo) };
  }

  @Delete('connection')
  async disconnect(@Req() req: Request) {
    await this.canva.disconnect(req.authContext!.userId);
    return { ok: true };
  }

  /** Canva sends the browser here after the user allowed (or refused) Studio; it goes on to the web app. */
  @Public()
  @Get('oauth/callback')
  async callback(@Query('code') code: string | undefined, @Query('state') state: string | undefined, @Query('error') error: string | undefined, @Res() res: Response) {
    res.redirect(HttpStatus.FOUND, await this.canva.callback({
      ...(code ? { code } : {}), ...(state ? { state } : {}), ...(error ? { error } : {}),
    }));
  }
}
