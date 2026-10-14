/**
 * The browser side of the test host. It loads the real report view into a sandboxed iframe and
 * speaks the host side of the MCP Apps protocol with the ext-apps AppBridge, as a real host does.
 * Bundled for the browser by bundleHost() in host-page.ts; the specs and scripts/demo-gif.ts drive it
 * through window.testHost and read what the view asked for from window.hostLog.
 */
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

type Theme = "light" | "dark";

export interface HostLog {
  initialized: boolean;
  messages: { role: string; content: { type: string; text?: string }[] }[];
  openLinks: { url: string }[];
}

export interface MountOptions {
  html: string;
  theme: Theme;
  width: number;
}

export interface TestHost {
  mount(options: MountOptions): Promise<void>;
  draw(input: Record<string, unknown>, result: { content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown> }): Promise<void>;
  setTheme(theme: Theme): void;
  setWidth(width: number): void;
  setPrompt(text: string | null): void;
}

declare global {
  interface Window {
    testHost: TestHost;
    hostLog: HostLog;
  }
}

const log: HostLog = { initialized: false, messages: [], openLinks: [] };
window.hostLog = log;

const box = document.getElementById("frame-box") as HTMLDivElement;
const prompt = document.getElementById("prompt") as HTMLParagraphElement;

let bridge: AppBridge | undefined;
let context: Record<string, unknown> = {};

function baseContext(theme: Theme, width: number) {
  return {
    theme,
    displayMode: "inline" as const,
    availableDisplayModes: ["inline" as const],
    containerDimensions: { maxWidth: width },
    locale: "en-US",
    timeZone: "UTC",
    platform: "web" as const,
  };
}

async function mount({ html, theme, width }: MountOptions): Promise<void> {
  document.body.dataset.theme = theme;
  box.style.width = `${width}px`;
  context = baseContext(theme, width);

  const iframe = document.createElement("iframe");
  iframe.title = "Report view";
  iframe.setAttribute("sandbox", "allow-scripts");
  box.replaceChildren(iframe);
  const target = iframe.contentWindow!;

  bridge = new AppBridge(
    null,
    { name: "test-host", version: "1.0.0" },
    { openLinks: {}, message: { text: {} } },
    { hostContext: context as never },
  );
  bridge.onsizechange = ({ height }) => {
    if (typeof height === "number") iframe.style.height = `${Math.ceil(height) + 2}px`;
  };
  bridge.onmessage = async (params) => {
    log.messages.push(params as HostLog["messages"][number]);
    return {};
  };
  bridge.onopenlink = async (params) => {
    log.openLinks.push({ url: params.url });
    return {};
  };
  const initialized = new Promise<void>((resolve) => {
    bridge!.oninitialized = () => {
      log.initialized = true;
      resolve();
    };
  });

  // The window proxy stays the same when srcdoc replaces about:blank, so listen before loading.
  await bridge.connect(new PostMessageTransport(target, target));
  iframe.srcdoc = html;
  await initialized;
}

async function draw(input: Record<string, unknown>, result: Parameters<TestHost["draw"]>[1]): Promise<void> {
  if (!bridge) throw new Error("mount the view first");
  await bridge.sendToolInput({ arguments: input });
  await bridge.sendToolResult(result as never);
}

function update(change: Record<string, unknown>) {
  context = { ...context, ...change };
  bridge?.setHostContext(context as never);
}

window.testHost = {
  mount,
  draw,
  setTheme(theme) {
    document.body.dataset.theme = theme;
    update({ theme });
  },
  setWidth(width) {
    box.style.width = `${width}px`;
    update({ containerDimensions: { maxWidth: width } });
  },
  setPrompt(text) {
    prompt.hidden = !text;
    prompt.querySelector("span")!.textContent = text ?? "";
  },
};
