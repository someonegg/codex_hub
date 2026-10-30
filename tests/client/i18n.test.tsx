// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import i18next from "i18next";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiClientError } from "../../src/client/api/client";
import { AttachCommand } from "../../src/client/components/AttachCommand";
import { MessageItem } from "../../src/client/components/MessageItem";
import { RequestError } from "../../src/client/components/RequestError";
import { Settings } from "../../src/client/components/Settings";
import { t } from "../../src/client/i18n";
import { settings as settingsEn } from "../../src/client/i18n/locales/en";
import { settings as settingsZh } from "../../src/client/i18n/locales/zh-CN";
import { LocalizedError } from "../../src/client/i18n/localized-error";
import { en, settingsZhTW, zh, zhTW } from "../../src/client/i18n/messages";
import { namespaceFor, partitionMessages } from "../../src/client/i18n/namespaces";
import { updatePreferences } from "../../src/client/state/preferences";

afterEach(() => {
  act(() => updatePreferences({ language: "en", theme: "mist", yolo: false }));
  vi.unstubAllGlobals();
});

describe("language preferences", () => {
  it("switches mounted settings to Chinese and persists without a reload", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    updatePreferences({ language: "en" });
    render(<Settings homes={[]} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Language", hidden: true }), {
      target: { value: "zh-CN" },
    });
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(screen.getByRole("combobox", { name: "语言", hidden: true })).toHaveValue("zh-CN");
    expect(JSON.parse(localStorage.getItem("ahub.preferences.v1")!).language).toBe("zh-CN");
  });
});

it("keeps old settings and rejects invalid persisted language values", () => {
  const stored = JSON.stringify({ language: "fr", theme: "warm", yolo: true });
  vi.stubGlobal("localStorage", { getItem: () => stored });
  window.dispatchEvent(new StorageEvent("storage", { key: "ahub.preferences.v1" }));
  expect(document.documentElement.lang).toBe("en");
  expect(document.documentElement.dataset.theme).toBe("warm");
});

it("continues switching when storage is unavailable", () => {
  vi.stubGlobal("localStorage", {
    setItem: () => {
      throw new Error("blocked");
    },
  });
  updatePreferences({ language: "en" });
  render(<Settings homes={[]} />);
  fireEvent.change(screen.getByRole("combobox", { name: "Language", hidden: true }), {
    target: { value: "zh-CN" },
  });
  expect(screen.getByRole("combobox", { name: "语言", hidden: true })).toHaveValue("zh-CN");
});

it("updates mounted controls when another tab selects Chinese", () => {
  updatePreferences({ language: "en" });
  render(<Settings homes={[]} />);
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ language: "zh-CN" }) });
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: "ahub.preferences.v1" })));
  expect(screen.getByRole("combobox", { name: "语言", hidden: true })).toHaveValue("zh-CN");
});

it("translates memoized labels while keeping conversation content intact", () => {
  updatePreferences({ language: "en" });
  const markdown = "Keep this English sentence and /original/path unchanged.";
  render(
    <MessageItem
      item={{
        id: "language-message",
        kind: "message",
        role: "assistant",
        phase: "response",
        itemType: null,
        ordinal: 0,
        timestamp: null,
        markdown,
      }}
    />,
  );
  expect(screen.getByText(/Assistant response/)).toBeInTheDocument();
  act(() => updatePreferences({ language: "zh-CN" }));
  expect(screen.getByText(/助手回复/)).toBeInTheDocument();
  expect(screen.getByText(markdown)).toBeInTheDocument();
});

it("translates an existing clipboard notification without rerunning the action", async () => {
  updatePreferences({ language: "en" });
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<AttachCommand command="tmux attach -t original" />);
  fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
  expect(await screen.findByText("Copied")).toBeInTheDocument();
  act(() => updatePreferences({ language: "zh-CN" }));
  expect(screen.getByText("已复制")).toBeInTheDocument();
  expect(writeText).toHaveBeenCalledExactlyOnceWith("tmux attach -t original");
});

it.each([
  [zh, settingsZh],
  [zhTW, settingsZhTW],
])("keeps dictionaries complete with matching interpolation parameters", (zh, settingsZh) => {
  expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  expect(Object.keys(settingsZh).sort()).toEqual(Object.keys(settingsEn).sort());
  const placeholders = (text: string) =>
    [...text.matchAll(/\{\{(\w+)(?:, number)?\}\}/g)].map((match) => match[1]).sort();
  for (const key of Object.keys(en) as Array<keyof typeof en>) {
    expect(zh[key].trim(), key).not.toBe("");
    expect(placeholders(zh[key]), key).toEqual(placeholders(en[key]));
  }
  const namespaced = Object.values(partitionMessages(en)).flatMap((group) => Object.keys(group));
  expect(namespaced.sort()).toEqual(Object.keys(en).sort());
});

it("formats plural counts and numbers using the selected language", () => {
  updatePreferences({ language: "en" });
  expect(t("events", { count: 1 })).toBe("1 event");
  expect(t("events", { count: 2 })).toBe("2 events");
  expect(t("characters", { count: 1892 })).toBe("1,892 characters");
  updatePreferences({ language: "zh-CN" });
  expect(t("events", { count: 1 })).toBe("1 条事件");
  expect(t("events", { count: 2 })).toBe("2 条事件");
  updatePreferences({ language: "zh-TW" });
  expect(t("events", { count: 2 })).toBe("2 條事件");
  expect(t("characters", { count: 1892 })).toBe("1,892 個字元");
});

it("falls back to English for a missing translation", () => {
  updatePreferences({ language: "zh-CN" });
  const namespace = namespaceFor.get("send") ?? "common";
  const bundle = i18next.getResourceBundle("zh-CN", namespace);
  const original = bundle.send;
  delete bundle.send;
  try {
    expect(t("send")).toBe("Send");
  } finally {
    bundle.send = original;
  }
});

it("uses structured error codes and retains native diagnostic details", () => {
  updatePreferences({ language: "en" });
  render(
    <RequestError error={new ApiClientError(409, "timeline_changed", "Native diagnostic /path")} />,
  );
  expect(screen.getByText("Native diagnostic /path")).toBeInTheDocument();
  act(() => updatePreferences({ language: "zh-CN" }));
  expect(screen.getByText(/会话已更改，请刷新后重试/)).toBeInTheDocument();
  expect(screen.getByText("Native diagnostic /path")).toBeInTheDocument();
});

it("translates an existing local error from its key", () => {
  updatePreferences({ language: "en" });
  render(<RequestError error={new LocalizedError("foldersAreNotSupported")} />);
  expect(screen.getByText("Folders are not supported")).toBeInTheDocument();
  act(() => updatePreferences({ language: "zh-CN" }));
  expect(screen.getByText("不支持文件夹")).toBeInTheDocument();
});
