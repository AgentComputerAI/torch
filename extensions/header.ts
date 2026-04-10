import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function center(text: string, width: number): string {
  const pad = Math.max(0, Math.floor((width - stripAnsi(text).length) / 2));
  return " ".repeat(pad) + text;
}

const Y = "\x1b[38;2;255;220;80m";
const O = "\x1b[38;2;255;160;20m";
const D = "\x1b[38;2;255;100;0m";
const R = "\x1b[38;2;200;60;0m";
const B = "\x1b[1m";
const X = "\x1b[0m";

function render(_theme: unknown, width: number): string[] {
  const title = [
    B + Y + "████████╗ ██████╗ ██████╗  ██████╗██╗  ██╗" + X,
    B + Y + "╚══██╔══╝██╔═══██╗██╔══██╗██╔════╝██║  ██║" + X,
    B + O + "   ██║   ██║   ██║██████╔╝██║     ███████║" + X,
    B + O + "   ██║   ██║   ██║██╔══██╗██║     ██╔══██║" + X,
    B + D + "   ██║   ╚██████╔╝██║  ██║╚██████╗██║  ██║" + X,
    B + R + "   ╚═╝    ╚═════╝ ╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝" + X,
  ];

  const sub = "\x1b[38;2;180;140;100m" + "AI web scraping agent" + X;

  const lines = [""];
  for (const l of title) lines.push(center(l, width));
  lines.push("");
  lines.push(center(sub, width));
  lines.push("");
  return lines;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setHeader((_tui, _theme) => ({
      render: (width: number) => render(_theme, width),
      invalidate() {},
    }));
    ctx.ui.setTitle("torch");
  });
}
