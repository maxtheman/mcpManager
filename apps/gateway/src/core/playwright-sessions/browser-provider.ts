import { chromium, firefox, webkit, type Browser, type BrowserType } from "playwright";

/**
 * Supported browser types for Playwright.
 */
type BrowserTypeName = "chromium" | "firefox" | "webkit";

/**
 * Configuration options for the BrowserProvider.
 */
interface BrowserProviderOptions {
  /** Browser engine to use. Defaults to "chromium". */
  browserType?: BrowserTypeName;
  /** Run browser in headless mode. Defaults to true. */
  headless?: boolean;
  /** Additional Playwright launch options. */
  launchOptions?: Record<string, unknown>;
}

/**
 * Handle returned when acquiring a browser instance.
 * Contains the browser reference and metadata about the acquisition.
 */
interface BrowserHandle {
  /** The Playwright Browser instance. */
  browser: Browser;
  /** The type of browser (chromium, firefox, webkit). */
  browserType: BrowserTypeName;
  /** Timestamp when the browser was acquired. */
  acquiredAt: number;
}

/**
 * Manages Playwright browser instance lifecycle.
 *
 * This class provides a centralized way to acquire and release browser instances.
 * Currently implements a single-browser model with reference counting, but is
 * designed to support future pooling capabilities.
 *
 * Key features:
 * - Lazy browser initialization (only launches when first acquired)
 * - Reference counting to track active users
 * - Prevents concurrent launch attempts
 * - Supports all Playwright browser types (chromium, firefox, webkit)
 *
 * @example
 * ```typescript
 * const provider = new BrowserProvider({ headless: true });
 * const handle = await provider.acquire();
 * const context = await handle.browser.newContext();
 * // ... use the context ...
 * await provider.release();
 * await provider.shutdown();
 * ```
 */
export class BrowserProvider {
  private browser: Browser | null = null;
  private browserType: BrowserTypeName = "chromium";
  private launching: Promise<Browser> | null = null;
  private refCount = 0;

  /**
   * Creates a new BrowserProvider instance.
   * @param options - Configuration options for the browser provider.
   */
  constructor(private options: BrowserProviderOptions = {}) {
    this.browserType = options.browserType ?? "chromium";
  }

  /**
   * Returns the Playwright BrowserType object for the configured browser.
   * @returns The BrowserType (chromium, firefox, or webkit).
   */
  private getBrowserType(): BrowserType {
    switch (this.browserType) {
      case "firefox":
        return firefox;
      case "webkit":
        return webkit;
      default:
        return chromium;
    }
  }

  /**
   * Acquire a browser instance. Reuses existing browser if available and connected.
   * Increments the reference count on successful acquisition.
   *
   * This method is safe to call concurrently - it prevents multiple simultaneous
   * browser launches by queuing requests during launch.
   *
   * @returns A BrowserHandle containing the browser instance and metadata.
   */
  async acquire(): Promise<BrowserHandle> {
    if (this.browser && this.browser.isConnected()) {
      this.refCount++;
      return {
        browser: this.browser,
        browserType: this.browserType,
        acquiredAt: Date.now(),
      };
    }

    // Prevent concurrent launches - wait for existing launch to complete
    if (this.launching) {
      await this.launching;
      return this.acquire();
    }

    this.launching = this.launch();
    try {
      this.browser = await this.launching;
      this.refCount = 1;
      return {
        browser: this.browser,
        browserType: this.browserType,
        acquiredAt: Date.now(),
      };
    } finally {
      this.launching = null;
    }
  }

  /**
   * Launches a new browser instance with configured options.
   * @returns A promise resolving to the launched Browser instance.
   */
  private async launch(): Promise<Browser> {
    const browserType = this.getBrowserType();
    return browserType.launch({
      headless: this.options.headless ?? true,
      ...this.options.launchOptions,
    });
  }

  /**
   * Release a browser reference. Decrements the reference count.
   *
   * Note: The browser is kept alive for reuse even when refCount reaches 0.
   * Use shutdown() to explicitly close the browser.
   */
  async release(): Promise<void> {
    this.refCount = Math.max(0, this.refCount - 1);
    // Keep browser alive for reuse - close only on explicit shutdown
  }

  /**
   * Force close the browser regardless of reference count.
   * Resets the provider to its initial state.
   *
   * Call this when shutting down the application or when you need
   * to ensure the browser is fully closed.
   */
  async shutdown(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.refCount = 0;
    }
  }

  /**
   * Check if a browser is currently available and connected.
   * @returns true if a browser instance exists and is connected.
   */
  isAvailable(): boolean {
    return this.browser !== null && this.browser.isConnected();
  }

  /**
   * Get the current reference count.
   * @returns The number of active references to the browser.
   */
  getRefCount(): number {
    return this.refCount;
  }
}

// Singleton instance for the gateway process
let defaultProvider: BrowserProvider | null = null;

/**
 * Get the default singleton BrowserProvider instance.
 *
 * Creates a new instance on first call with the provided options.
 * Subsequent calls return the existing instance (options are ignored).
 *
 * @param options - Configuration options (only used on first call).
 * @returns The singleton BrowserProvider instance.
 */
export function getDefaultBrowserProvider(options?: BrowserProviderOptions): BrowserProvider {
  if (!defaultProvider) {
    defaultProvider = new BrowserProvider(options);
  }
  return defaultProvider;
}
