import { Global, Injectable, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSiteNameCache, fetchAgGoSiteName, type SiteNameCache } from '@ag-studio/engine';

/**
 * What people call the footage library: ag-go's own `siteName` (its public settings), reloaded every 10 minutes;
 * "AG Go" until ag-go answers. For error messages and the agent's tool descriptions.
 */
@Injectable()
export class SiteNameService implements OnModuleInit {
  private readonly cache: SiteNameCache;

  constructor(config: ConfigService) {
    const baseUrl = config.get<string>('AG_GO_API_URL');
    this.cache = createSiteNameCache({ load: () => (baseUrl ? fetchAgGoSiteName(baseUrl) : Promise.reject(new Error('no AG_GO_API_URL'))) });
  }

  onModuleInit(): void {
    void this.cache.refresh(); // warm, without holding the start-up
  }

  current(): string {
    return this.cache.current();
  }
}

@Global()
@Module({ providers: [SiteNameService], exports: [SiteNameService] })
export class SiteNameModule {}
