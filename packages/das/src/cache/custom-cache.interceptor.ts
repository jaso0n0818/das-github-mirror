import { CacheInterceptor } from "@nestjs/cache-manager";
import { ExecutionContext, Injectable, SetMetadata } from "@nestjs/common";

export const NO_CACHE_KEY = "no-cache";

/** Opt-out decorator: mark a GET handler as uncacheable. */
export const NoCache = (): MethodDecorator & ClassDecorator =>
  SetMetadata(NO_CACHE_KEY, true);

@Injectable()
export class CustomCacheInterceptor extends CacheInterceptor {
  protected isRequestCacheable(context: ExecutionContext): boolean {
    const noCache = this.reflector.get<boolean>(
      NO_CACHE_KEY,
      context.getHandler(),
    );
    if (noCache) return false;
    return super.isRequestCacheable(context);
  }
}
