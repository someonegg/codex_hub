import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { tsImport } from "tsx/esm/api";

const { en, zh, settingsEn, settingsZh } = await tsImport(
  "../src/client/i18n/messages.ts",
  import.meta.url,
);

export function docsOptions(defaultOutput) {
  const args = process.argv.slice(2);
  const index = args.indexOf("--language");
  let language = "en";
  if (index !== -1) {
    language = args[index + 1];
    args.splice(index, 2);
  }
  if (language !== "en" && language !== "zh-CN") throw new Error("Unsupported --language");
  const output = resolve(
    args[1] ??
      defaultOutput.replace(
        "docs/images/",
        language === "en" ? "docs/images/" : "docs/images/zh-CN/",
      ),
  );
  mkdirSync(dirname(output), { recursive: true });
  return { language, origin: args[0] ?? "http://127.0.0.1:4187", output };
}

const settings = Object.fromEntries(
  Object.entries(settingsEn).map(([key, text]) => [text, settingsZh[key]]),
);
const demoText = {
  "Design the project dashboard": "设计项目仪表盘",
  "Improve the project dashboard": "改进项目仪表盘",
  "Suggest three improvements for this project dashboard.": "请为这个项目仪表盘提出三项改进建议。",
  "Dashboard focus": "仪表盘重点",
  "Which area should we improve first?": "我们应该先改进哪个方面？",
  "Project health": "项目健康状况",
  "Show status and next steps at a glance.": "一目了然地展示状态和下一步工作。",
  "Recent activity": "近期活动",
  "Highlight the latest changes and decisions.": "突出显示最新变更与决策。",
  "Start with **project health**, then highlight recent activity and keep navigation clear.":
    "先展示**项目健康状况**，再突出近期活动，并保持导航清晰。",
  "Three focused improvements": "三项重点改进",
  "### Three focused improvements\n\n1. **Show project health.** Put status and open tasks at the top.\n2. **Highlight recent activity.** Surface the latest changes and decisions.\n3. **Keep navigation clear.** Group sessions by project for quick access.":
    "### 三项重点改进\n\n1. **展示项目健康状况。** 将状态和待办事项放在顶部。\n2. **突出近期活动。** 展示最新变更和决策。\n3. **保持导航清晰。** 按项目组织会话，方便快速访问。",
};

export function translateFixture(value, language) {
  if (language === "en") return value;
  if (typeof value === "string") return demoText[value] ?? value;
  if (Array.isArray(value)) return value.map((item) => translateFixture(item, language));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, translateFixture(item, language)]),
    );
  return value;
}

/** Inject only the explicit label helper and language into the serialized scenario. */
export function captureSource(fn, language) {
  const labels =
    language === "en"
      ? {}
      : {
          ...Object.fromEntries(Object.entries(en).map(([key, text]) => [text, zh[key]])),
          ...settings,
          "Shift+Enter for newline": "Shift+Enter 换行",
          ...demoText,
        };
  const source = fn.toString();
  const start = source.indexOf("{");
  const declarations = `
    const language = ${JSON.stringify(language)};
    const labels = ${JSON.stringify(labels)};
    const label = (text, values = {}) => {
      let translated = labels[text] ?? text;
      for (const prefix of ["Preview", "Remove", "Expand", "Collapse"]) {
        if (text.startsWith(prefix + " ") && labels[prefix + " {{filename}}"])
          translated = labels[prefix + " {{filename}}"].replace("{{filename}}", text.slice(prefix.length + 1));
      }
      return translated.replace(/\\{\\{(\\w+)(?:, number)?\\}\\}/g, (match, key) => values[key] ?? match);
    };
  `;
  return source.slice(0, start + 1) + declarations + source.slice(start + 1);
}
