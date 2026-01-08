import type { Page, BrowserContext } from "playwright";

export type PlaywrightToolName =
  | "browser_navigate"
  | "browser_click"
  | "browser_type"
  | "browser_fill_form"
  | "browser_press_key"
  | "browser_hover"
  | "browser_select_option"
  | "browser_drag"
  | "browser_snapshot"
  | "browser_take_screenshot"
  | "browser_evaluate"
  | "browser_wait_for"
  | "browser_tabs"
  | "browser_close"
  | "browser_navigate_back";

export interface DispatchResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  newPageCreated?: boolean;
}

interface ToolArgs {
  url?: string;
  selector?: string;
  ref?: string;
  element?: string;
  text?: string;
  key?: string;
  values?: string[];
  fields?: Array<{
    name: string;
    type: string;
    ref: string;
    value: string;
  }>;
  fullPage?: boolean;
  filename?: string;
  type?: "png" | "jpeg";
  function?: string;
  time?: number;
  textGone?: string;
  startRef?: string;
  startElement?: string;
  endRef?: string;
  endElement?: string;
  action?: "list" | "new" | "close" | "select";
  index?: number;
  [key: string]: unknown;
}

function requireString(value: unknown, message: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(message);
}

function requireStringArray(value: unknown, message: string): string[] {
  if (!Array.isArray(value)) throw new Error(message);
  const strings = value.filter((v) => typeof v === "string");
  if (strings.length !== value.length) throw new Error(message);
  return strings;
}

function resolveSelector(args: ToolArgs): string | null {
  if (args.ref) return `[data-ref="${args.ref}"]`;
  if (args.selector) return args.selector;
  if (args.element) return `text=${args.element}`;
  return null;
}

function requireSelector(args: ToolArgs): string {
  const selector = resolveSelector(args);
  if (!selector) throw new Error("selector, ref, or element is required");
  return selector;
}

type HandlerParams = {
  page: Page;
  context: BrowserContext;
  args: ToolArgs;
  timeoutMs: number;
};

type ToolHandler = (params: HandlerParams) => Promise<DispatchResult>;

async function handleFillForm(params: HandlerParams): Promise<DispatchResult> {
  const { page, args, timeoutMs } = params;
  if (!args.fields || !Array.isArray(args.fields)) {
    throw new Error("fields array is required");
  }

  for (const field of args.fields) {
    const selector = field.ref ? `[data-ref="${field.ref}"]` : null;
    if (!selector) continue;

    switch (field.type) {
      case "checkbox": {
        const checked = field.value === "true";
        if (checked) {
          await page.check(selector, { timeout: timeoutMs });
        } else {
          await page.uncheck(selector, { timeout: timeoutMs });
        }
        break;
      }
      case "combobox": {
        await page.selectOption(selector, field.value, { timeout: timeoutMs });
        break;
      }
      default: {
        await page.fill(selector, field.value, { timeout: timeoutMs });
        break;
      }
    }
  }

  return { ok: true };
}

async function handleTabs(params: HandlerParams): Promise<DispatchResult> {
  const { page, context, args } = params;
  const pages = context.pages();

  switch (args.action) {
    case "list": {
      const result = await Promise.all(
        pages.map(async (p, i) => ({
          index: i,
          url: p.url(),
          title: await p.title().catch(() => ""),
          isCurrent: p === page,
        })),
      );
      return { ok: true, result };
    }
    case "new": {
      await context.newPage();
      return { ok: true, result: { index: pages.length }, newPageCreated: true };
    }
    case "close": {
      if (args.index !== undefined && pages[args.index]) {
        await pages[args.index].close();
      } else {
        await page.close();
      }
      return { ok: true };
    }
    case "select":
      return { ok: true, result: { note: "Use setActivePage on session" } };
    default:
      throw new Error(`Unknown tabs action: ${args.action}`);
  }
}

const TOOL_HANDLERS: Record<PlaywrightToolName, ToolHandler> = {
  browser_navigate: async ({ page, args, timeoutMs }) => {
    const url = requireString(args.url, "url is required");
    await page.goto(url, { timeout: timeoutMs });
    return { ok: true, result: { url: page.url(), title: await page.title() } };
  },
  browser_navigate_back: async ({ page, timeoutMs }) => {
    await page.goBack({ timeout: timeoutMs });
    return { ok: true, result: { url: page.url() } };
  },
  browser_click: async ({ page, args, timeoutMs }) => {
    await page.click(requireSelector(args), { timeout: timeoutMs });
    return { ok: true };
  },
  browser_type: async ({ page, args, timeoutMs }) => {
    await page.fill(requireSelector(args), requireString(args.text, "text is required"), { timeout: timeoutMs });
    return { ok: true };
  },
  browser_fill_form: handleFillForm,
  browser_press_key: async ({ page, args }) => {
    const key = requireString(args.key, "key is required");
    await page.keyboard.press(key);
    return { ok: true };
  },
  browser_hover: async ({ page, args, timeoutMs }) => {
    await page.hover(requireSelector(args), { timeout: timeoutMs });
    return { ok: true };
  },
  browser_select_option: async ({ page, args, timeoutMs }) => {
    const values = requireStringArray(args.values, "values is required");
    await page.selectOption(requireSelector(args), values, { timeout: timeoutMs });
    return { ok: true };
  },
  browser_drag: async ({ page, args, timeoutMs }) => {
    const startRef = requireString(args.startRef, "startRef and endRef are required");
    const endRef = requireString(args.endRef, "startRef and endRef are required");
    await page.dragAndDrop(`[data-ref="${startRef}"]`, `[data-ref="${endRef}"]`, { timeout: timeoutMs });
    return { ok: true };
  },
  browser_snapshot: async ({ page }) => {
    const url = page.url();
    const title = await page.title();
    const content = await page.content();
    return {
      ok: true,
      result: {
        url,
        title,
        contentLength: content.length,
        snapshot: `Page: ${title}\nURL: ${url}\nContent length: ${content.length} bytes`,
      },
    };
  },
  browser_take_screenshot: async ({ page, args }) => {
    const options: { fullPage?: boolean; type?: "png" | "jpeg"; path?: string } = {};
    if (args.fullPage) options.fullPage = true;
    if (args.type) options.type = args.type;
    if (args.filename) options.path = args.filename;

    const buffer = await page.screenshot(options);
    return {
      ok: true,
      result: {
        data: buffer.toString("base64"),
        mimeType: args.type === "jpeg" ? "image/jpeg" : "image/png",
        path: args.filename,
      },
    };
  },
  browser_evaluate: async ({ page, args }) => {
    const fn = requireString(args.function, "function is required");
    const result = await page.evaluate(`(${fn})()`);
    return { ok: true, result };
  },
  browser_wait_for: async ({ page, args, timeoutMs }) => {
    if (args.time) {
      await page.waitForTimeout(args.time * 1000);
      return { ok: true };
    }
    if (args.text) {
      await page.waitForSelector(`text=${args.text}`, { timeout: timeoutMs });
      return { ok: true };
    }
    if (args.textGone) {
      await page.waitForSelector(`text=${args.textGone}`, { state: "hidden", timeout: timeoutMs });
      return { ok: true };
    }
    throw new Error("time, text, or textGone is required");
  },
  browser_tabs: handleTabs,
  browser_close: async ({ page }) => {
    await page.close();
    return { ok: true };
  },
};

export async function dispatchTool(params: {
  tool: PlaywrightToolName;
  page: Page;
  context: BrowserContext;
  args: ToolArgs;
  timeoutMs?: number;
}): Promise<DispatchResult> {
  const { tool, page, context, args, timeoutMs = 30000 } = params;

  const handler = TOOL_HANDLERS[tool];
  try {
    if (!handler) {
      throw new Error(`Unknown tool: ${tool}`);
    }
    return await handler({ page, context, args, timeoutMs });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
