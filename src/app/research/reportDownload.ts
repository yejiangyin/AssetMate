import type { ResearchReport } from "./types";

export interface ResearchArchiveEntry {
  path: string;
  content: string;
}

function safeFilePart(value: string) {
  return value
    .replace(/[<>:"/\\|?*]/g, "-")
    .split("")
    .filter((character) => character.charCodeAt(0) >= 32)
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "research-report";
}

function reportTimestamp(report: ResearchReport) {
  return report.createdAt.slice(0, 16).replace(/[-:T]/g, "").slice(0, 12);
}

function reportTargetFolder(report: ResearchReport) {
  const symbol = report.target.symbol || report.target.displaySymbol || "";
  const name = report.target.name || symbol || "research-target";
  const suffix = symbol && !name.includes(symbol) ? ` ${symbol}` : "";
  return safeFilePart(`${name}${suffix}`);
}

function markdownCell(value: unknown) {
  return String(value ?? "—").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim() || "—";
}

function researchDataAppendix(report: ResearchReport, language: "zh" | "en") {
  if (!report.dataStatus && !report.targetContexts?.length) return "";
  const isEn = language === "en";
  const lines = [
    `## ${isEn ? "Local research-data snapshot" : "本地研究数据快照"}`,
    "",
  ];
  if (report.dataStatus) {
    lines.push(
      `- ${isEn ? "Coverage" : "覆盖状态"}: ${report.dataStatus.status}`,
      `- ${isEn ? "Targets meeting required-data rules" : "满足必需数据规则的标的"}: ${report.dataStatus.completeTargets}/${report.dataStatus.targetCount}`,
    );
    if (report.dataStatus.warnings.length) lines.push(`- ${isEn ? "Data gaps" : "数据缺口"}: ${report.dataStatus.warnings.join("; ")}`);
    lines.push("");
  }
  if (report.targetContexts?.length) {
    lines.push(
      `| ${isEn ? "Target" : "标的"} | ${isEn ? "Dataset" : "数据集"} | ${isEn ? "Requirement" : "要求"} | ${isEn ? "Status" : "状态"} | ${isEn ? "Provider / source" : "服务商 / 来源"} | ${isEn ? "Data date" : "数据日期"} | ${isEn ? "Freshness / adjustment" : "时效 / 复权"} |`,
      "|---|---|---|---|---|---|---|",
    );
    report.targetContexts.forEach((context) => {
      context.provenance.forEach((item) => {
        const provider = item.sourceUrl ? `[${item.provider}](${item.sourceUrl})` : item.provider;
        lines.push(`| ${markdownCell(`${context.target.name || context.target.symbol} ${context.target.symbol}`)} | ${markdownCell(item.dataset)} | ${markdownCell(item.requirementGroup || item.requirement)} | ${markdownCell(item.stale ? `${item.status} (stale)` : item.status)} | ${provider} | ${markdownCell(item.dataDate)} | ${markdownCell([item.freshness, item.ageDays != null ? `${item.ageDays}d` : "", item.adjustmentMode].filter(Boolean).join(" / "))} |`);
      });
    });
  }
  return lines.join("\n");
}

function researchProviderLines(report: ResearchReport, language: "zh" | "en") {
  if (!report.providerRoute) return [];
  const isEn = language === "en";
  return [
    `- ${isEn ? "Execution API" : "执行 API"}: ${[report.providerRoute.execution.profileName, report.providerRoute.execution.model].filter(Boolean).join(" · ")}`,
    ...(report.providerRoute.synthesis ? [`- ${isEn ? "Synthesis API" : "综合 API"}: ${[report.providerRoute.synthesis.profileName, report.providerRoute.synthesis.model].filter(Boolean).join(" · ")}`] : []),
    `- ${isEn ? "Audit API" : "审计 API"}: ${report.providerRoute.audit ? [report.providerRoute.audit.profileName, report.providerRoute.audit.model].filter(Boolean).join(" · ") : (isEn ? "Local checks only" : "仅本地检查")}`,
    ...(report.providerRoute.professionalData ? [`- ${isEn ? "Professional data" : "专业数据"}: ${report.providerRoute.professionalData.profileName} · DataPro MCP`] : []),
    ...(report.professionalData?.requested ? [`- ${isEn ? "DataPro result" : "专业数据结果"}: ${report.professionalData.items.length}/${report.professionalData.queries.length} · ${report.professionalData.datasetTypes.join(", ") || (isEn ? "server-routed" : "服务端自动路由")}`] : []),
  ];
}

export function researchReportFilename(report: ResearchReport) {
  return `${reportTimestamp(report)}-${safeFilePart(report.title || report.target.name || report.target.symbol || "research-report")}.md`;
}

export function researchReportSectionFilename(report: ResearchReport, sectionTitle: string) {
  return `${reportTimestamp(report)}-${safeFilePart(report.title || report.target.name || report.target.symbol || "research-report")}-${safeFilePart(sectionTitle)}.md`;
}

export function buildResearchReportsBundle(reports: ResearchReport[], language: "zh" | "en") {
  const isEn = language === "en";
  const sorted = [...reports].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const generatedAt = new Date().toISOString().slice(0, 16).replace("T", " ");
  const header = [
    `# ${isEn ? "Research report collection" : "投研报告合集"}`,
    "",
    `- ${isEn ? "Exported at" : "导出时间"}: ${generatedAt}`,
    `- ${isEn ? "Reports" : "报告数量"}: ${sorted.length}`,
  ].join("\n");
  const sections = sorted.map((report, index) => [
    "---",
    "",
    `# ${index + 1}. ${report.title}`,
    "",
    `- ${isEn ? "Research date" : "研究日期"}: ${report.createdAt.slice(0, 16).replace("T", " ")}`,
    `- ${isEn ? "Data cutoff" : "数据截止"}: ${report.dataCutoff}`,
    `- ${isEn ? "Report citations" : "正文引用来源数量"}: ${report.sources.length}`,
    ...researchProviderLines(report, language),
    "",
    researchDataAppendix(report, language),
    "",
    report.markdown.trim(),
  ].join("\n"));
  return `${header}\n\n${sections.join("\n\n")}\n`;
}

export function buildResearchReportBundle(report: ResearchReport, language: "zh" | "en") {
  const isEn = language === "en";
  const agentResults = report.agentResults ?? [];
  const sections = [
    { title: isEn ? "Synthesis" : "综合报告", content: report.markdown },
    ...agentResults.map((agent) => ({ title: agent.title, content: agent.content })),
  ];
  const header = [
    `# ${report.title} - ${isEn ? "Full report" : "整份报告"}`,
    "",
    `- ${isEn ? "Export type" : "导出类型"}: ${isEn ? "Full report, including every section" : "整份报告，包含所有分栏"}`,
    `- ${isEn ? "Research date" : "研究日期"}: ${report.createdAt.slice(0, 16).replace("T", " ")}`,
    `- ${isEn ? "Data cutoff" : "数据截止"}: ${report.dataCutoff}`,
    `- ${isEn ? "Report citations" : "正文引用来源数量"}: ${report.sources.length}`,
    `- ${isEn ? "Sections" : "报告分栏"}: ${agentResults.length + 1}`,
    ...researchProviderLines(report, language),
    "",
    `## ${isEn ? "Table of contents" : "目录"}`,
    "",
    ...sections.map((section, index) => `${index + 1}. ${section.title}`),
  ].join("\n");
  const sectionBlocks = sections.map((section, index) => [
    "---",
    "",
    `## ${index + 1}. ${section.title}`,
    "",
    section.content.trim(),
  ].join("\n"));
  const dataAppendix = researchDataAppendix(report, language);
  return `${header}\n\n${dataAppendix ? `${dataAppendix}\n\n` : ""}${sectionBlocks.join("\n\n")}\n`;
}

export function buildResearchReportSectionBundle(
  report: ResearchReport,
  sectionTitle: string,
  markdown: string,
  language: "zh" | "en",
) {
  const isEn = language === "en";
  const header = [
    `# ${report.title} - ${sectionTitle}`,
    "",
    `- ${isEn ? "Export type" : "导出类型"}: ${isEn ? "Current section only" : "仅当前分栏"}`,
    `- ${isEn ? "Section" : "分栏"}: ${sectionTitle}`,
    `- ${isEn ? "Research date" : "研究日期"}: ${report.createdAt.slice(0, 16).replace("T", " ")}`,
    `- ${isEn ? "Data cutoff" : "数据截止"}: ${report.dataCutoff}`,
    ...researchProviderLines(report, language),
    "",
    researchDataAppendix(report, language),
    "",
    "---",
    "",
    `## ${sectionTitle}`,
    "",
    markdown.trim(),
  ].join("\n");
  return `${header}\n`;
}

export function buildResearchReportArchiveEntries(reports: ResearchReport[], language: "zh" | "en"): ResearchArchiveEntry[] {
  const sorted = [...reports].sort((a, b) => {
    const targetCompare = reportTargetFolder(a).localeCompare(reportTargetFolder(b), language === "zh" ? "zh-Hans-CN" : "en");
    if (targetCompare !== 0) return targetCompare;
    return b.createdAt.localeCompare(a.createdAt);
  });
  const used = new Map<string, number>();
  return sorted.map((report) => {
    const folder = reportTargetFolder(report);
    const filename = researchReportFilename(report);
    const basePath = `${folder}/${filename}`;
    const count = used.get(basePath) ?? 0;
    used.set(basePath, count + 1);
    const path = count === 0 ? basePath : basePath.replace(/\.md$/i, `-${count + 1}.md`);
    return { path, content: buildResearchReportBundle(report, language) };
  });
}

export function downloadTextFile(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadBlobFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

const CRC_TABLE = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosDate, dosTime };
}

function u16(value: number) {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function u32(value: number) {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

function concatBytes(parts: Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function buildStoredZip(entries: ResearchArchiveEntry[]) {
  const encoder = new TextEncoder();
  const { dosDate, dosTime } = dosDateTime();
  const fileParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    const contentBytes = encoder.encode(entry.content);
    const crc = crc32(contentBytes);
    const localHeader = concatBytes([
      u32(0x04034b50),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(dosTime),
      u16(dosDate),
      u32(crc),
      u32(contentBytes.length),
      u32(contentBytes.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
    ]);
    fileParts.push(localHeader, contentBytes);
    centralParts.push(concatBytes([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0x0800),
      u16(0),
      u16(dosTime),
      u16(dosDate),
      u32(crc),
      u32(contentBytes.length),
      u32(contentBytes.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBytes,
    ]));
    offset += localHeader.length + contentBytes.length;
  }
  const centralDirectory = concatBytes(centralParts);
  const end = concatBytes([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDirectory.length),
    u32(offset),
    u16(0),
  ]);
  return concatBytes([...fileParts, centralDirectory, end]);
}

export function downloadResearchReportSection(report: ResearchReport, sectionTitle: string, markdown: string, language: "zh" | "en") {
  downloadTextFile(buildResearchReportSectionBundle(report, sectionTitle, markdown, language), researchReportSectionFilename(report, sectionTitle));
}

export function downloadFullResearchReport(report: ResearchReport, language: "zh" | "en") {
  downloadTextFile(buildResearchReportBundle(report, language), researchReportFilename(report));
}

export function downloadResearchReports(reports: ResearchReport[], language: "zh" | "en") {
  if (!reports.length) return;
  if (reports.length === 1) {
    downloadFullResearchReport(reports[0]!, language);
    return;
  }
  const now = new Date();
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const entries = buildResearchReportArchiveEntries(reports, language);
  const zipBytes = buildStoredZip(entries);
  downloadBlobFile(new Blob([zipBytes], { type: "application/zip" }), `${language === "en" ? "research-reports" : "投研报告合集"}-${date}.zip`);
}
