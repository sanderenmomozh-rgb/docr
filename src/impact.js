/**
 * Preview the impact of ingesting a source document.
 * Shows what wiki pages would be created/updated.
 * This is a PREVIEW only — no filesystem changes.
 */
export async function previewImpact(analysis, suggestions, vaultPath) {
  const wouldCreate = [];
  const wouldUpdate = [];
  const affectedEntityPages = [];

  const sp = analysis.suggestedPlacement;

  // Determine new pages to create
  switch (analysis.type) {
    case "faq-csv":
      wouldCreate.push({
        path: `${sp.wikiDir}/${sp.suggestedFilename}.md`,
        title: sp.suggestedFilename,
        template: sp.template,
        reason: "FAQ dataset — one page per category group",
      });
      break;

    case "system-spec":
      // System specs typically produce: guide + feature pages
      wouldCreate.push({
        path: `${sp.wikiDir}/${sp.suggestedFilename}.md`,
        title: sp.suggestedFilename,
        template: sp.template,
        reason: "系统需求文档 — 特性说明页",
      });
      {
        const guideName = sp.suggestedFilename.replace("特性说明", "操作指引");
        wouldCreate.push({
          path: `${vaultPath}/wiki/guides/${guideName}.md`,
          title: guideName,
          template: "tpl-guide.md",
          reason: "系统需求文档 — 操作指引页（从特性说明派生）",
        });
      }
      break;

    case "policy-doc":
      wouldCreate.push({
        path: `${sp.wikiDir}/${sp.suggestedFilename}.md`,
        title: sp.suggestedFilename,
        template: sp.template,
        reason: "政策文件 — 解读页",
      });
      break;

    case "field-spec":
      wouldCreate.push({
        path: `${vaultPath}/raw/specs/${sp.suggestedFilename}.md`,
        title: sp.suggestedFilename,
        template: "raw/specs (Layer 1 — immutable source)",
        reason: "字段规格 — 提取到 raw/specs/",
      });
      break;

    default:
      if (sp.suggestedFilename) {
        wouldCreate.push({
          path: `${sp.wikiDir}/${sp.suggestedFilename}.md`,
          title: sp.suggestedFilename,
          template: sp.template,
          reason: "General source — standard answer page",
        });
      }
  }

  // Check entity pages that would need link updates
  const entityKeywords = getEntityKeywords(analysis);
  for (const s of suggestions) {
    if (s.path.includes("/entities/")) {
      affectedEntityPages.push(s.path);
    }
    // High similarity pages would be updated with new cross-references
    if (s.score > 0.4) {
      wouldUpdate.push({
        path: s.path,
        title: s.title,
        changes: [`添加交叉引用: [[${sp.suggestedFilename}]]`, `更新链接列表`],
      });
    }
  }

  // Deduplicate
  const uniqueCreate = wouldCreate.filter(
    (c, i, arr) => arr.findIndex((x) => x.path === c.path) === i
  );
  const uniqueUpdate = wouldUpdate.filter(
    (u, i, arr) => arr.findIndex((x) => x.path === u.path) === i
  );

  return {
    source: analysis.filename,
    type: analysis.type,
    wordCount: analysis.wordCount,
    imageCount: analysis.images?.length || 0,
    estimatedPageCount: uniqueCreate.length,
    wouldCreate: uniqueCreate,
    wouldUpdate: uniqueUpdate,
    affectedEntityPages: [...new Set(affectedEntityPages)],
    hasTemporalData: analysis.keyInfo?.hasTemporalFlag || false,
  };
}

function getEntityKeywords(analysis) {
  const text = [
    analysis.summary || "",
    analysis.filename,
    analysis.keyInfo?.scope || "",
  ].join(" ");

  const entities = [];
  if (/咨询/.test(text)) entities.push("咨询服务");
  if (/薪酬/.test(text)) entities.push("薪酬");
  if (/员工/.test(text)) entities.push("员工");
  if (/背调/.test(text)) entities.push("背调");
  if (/飞书/.test(text)) entities.push("飞书服务台");
  if (/SSC|ssc/.test(text)) entities.push("SSC");
  if (/HR|hr/.test(text)) entities.push("HR");
  return entities;
}
