# Design QA — API connection accordion

- Source visual truth: `/var/folders/mq/6n12hvnx29l_p9fv18d4dmp00000gn/T/codex-clipboard-0a97b66c-0cff-444e-8378-53689511106b.png`
- Structural requirement: replace the single connection picker with a connection list whose rows expand inline.
- Implementation screenshot: `/Users/yejiangyin/.codex/visualizations/2026/07/15/019f63b5-94f5-7c62-bde9-e78338f0585b/accordion/final-expanded.png`
- Collapsed-list screenshot: `/Users/yejiangyin/.codex/visualizations/2026/07/15/019f63b5-94f5-7c62-bde9-e78338f0585b/accordion/two-connections-collapsed-v1.png`
- Full-view comparison evidence: `/Users/yejiangyin/.codex/visualizations/2026/07/15/019f63b5-94f5-7c62-bde9-e78338f0585b/accordion/reference-final-comparison.png`
- Focused-region comparison evidence: the full-view comparison is already cropped to the AI API card at readable control/text scale, so a second crop was not needed.
- Viewport: 400 × 600 CSS pixels.
- Theme and state: light theme; two API connections; one active connection expanded; alternate capture with both rows collapsed.

## Findings

- No actionable P0, P1, or P2 differences remain.
- The replacement of the old connection dropdown/action strip with a list header, summary rows, active badge, and inline editor is intentional and directly implements the requested structural change.
- Fonts and typography: existing app font stack, weights, compact labels, and truncation behavior match the source visual language. Summary metadata stays on one line at popup width.
- Spacing and layout rhythm: card padding, 8–12 px gaps, border radii, form grid, and vertical density remain aligned with the source. Expanded content stays within the 400 px popup without horizontal overflow.
- Colors and visual tokens: the implementation reuses `app-card`, `app-surface`, `app-border`, `app-accent`, and existing muted text tokens. Active/expanded state adds only a restrained accent border and tint.
- Image quality and asset fidelity: the reference contains no raster imagery or custom illustration. Existing Lucide icons from the product are retained at consistent optical sizes; no placeholder or handcrafted asset was introduced.
- Copy and content: the original API fields and safety copy are preserved. New list copy clearly explains that rows can be expanded, and each summary exposes provider, model count, selected model, and active state.
- Accessibility and interaction: row buttons expose `aria-expanded` and `aria-controls`; only one editor is present at a time. Add, collapse, switch, duplicate, and delete controls have accessible names.

## Interaction verification

- Add connection: list count changed from one to two and the new connection expanded automatically.
- Collapse active row: expanded editor count changed from one to zero.
- Switch rows: exactly one row and one editor became expanded; active state moved to the selected row.
- Browser console errors: none.

## Comparison history

- Pass 1: no P0/P1/P2 findings. The implementation preserved the supplied visual system while making the requested dropdown-to-accordion structural change, so no corrective visual iteration was required.

## Implementation checklist

- [x] Replace connection dropdown with list rows.
- [x] Expand and collapse configuration inline.
- [x] Keep only one connection editor open at a time.
- [x] Surface provider, model count, selected model, and active status in each row.
- [x] Preserve add, duplicate, delete, test, save, model-library, and API-key behavior.
- [x] Verify the 400 × 600 popup viewport and console state.

## Follow-up polish

- No blocking polish remains. Optional future enhancement: show the latest successful connection-test timestamp in the collapsed summary row.

---

# Design QA — Token slider and model-aware thinking depth

- Source visual truth: `/var/folders/mq/6n12hvnx29l_p9fv18d4dmp00000gn/T/codex-clipboard-3eaf1402-9ea9-44a9-b094-9b3a6143c13b.png`
- Structural requirement: replace the numeric output-token field with a draggable discrete slider, and make thinking-depth choices reflect provider/model capabilities instead of a universal three-level mapping.
- Implementation screenshot: `/Users/yejiangyin/.codex/visualizations/2026/07/15/019f63b5-94f5-7c62-bde9-e78338f0585b/token-thinking/implementation-final.png`
- Comparison evidence: the source and implementation were opened together in one visual comparison input at the same 400 px logical popup width.
- Viewport: 400 × 600 CSS pixels.
- Theme and state: light theme; OpenAI preset; no model selected; automatic thinking depth; 8,000-token step selected.

## Findings

- No actionable P0, P1, or P2 visual differences remain.
- The slider is an intentional replacement for the source numeric field. It uses the existing card radius, border, accent, control background, muted labels, and compact typography.
- Eight labels remain legible without horizontal overflow: 1K, 2K, 4K, 8K, 16K, 32K, 64K, and 128K.
- The selected value is reinforced by progress color, the visible numeric output, and the highlighted node label; the control remains compact enough for the extension popup.
- The thinking-depth note fits the existing two-column form rhythm and explains that model support can vary.
- No dropdown-arrow displacement, clipping, unexpected wrapping, or horizontal overflow was visible in the reviewed region.

## Interaction verification

- Dragging the thumb from 8K to 64K changed the displayed value to 64,000.
- Clicking the 8K node restored the value to 8,000.
- The slider exposes a single accessible `slider` role, current/min/max values, Home/End keys, and arrow-key stepping.
- Switching the preset to Anthropic changed the visible options to automatic/off/low/medium/high and showed the model-specific extended-level note.
- Provider/model capability mapping and request payload mapping are covered by automated tests.
- Browser console errors: none.

## Comparison history

- Pass 1: native range rendering produced an overly dark unselected track in the browser capture.
- Pass 2: replaced native visual rendering with a product-themed track while retaining pointer, keyboard, and accessibility behavior.
- Pass 3: direct drag, node click, dynamic provider options, 400 × 600 layout, and console state all passed.

final result: passed

---

# Design QA — Scannable research model plan

- Source visual truth: `/var/folders/mq/6n12hvnx29l_p9fv18d4dmp00000gn/T/codex-clipboard-b8d9dc46-43ba-436f-a60c-e57f0b0bce72.png`
- Structural requirement: reduce the text-heavy model-routing panel and make execution, synthesis, audit, active models, web-search state, and resume behavior recognizable at a glance.
- Implementation screenshot: `/Users/yejiangyin/Desktop/资产助手/audit/model-routing-visual-redesign.png`
- Focused-region screenshot: `/Users/yejiangyin/Desktop/资产助手/audit/model-routing-focused.png`
- Viewport: 400 × 600 CSS pixels, matching the extension popup surface represented by the 2× source capture.
- Theme and state: light theme; “投研团队” selected; model plan expanded; three-stage execution/synthesis/audit route visible.
- Full-view comparison evidence: the source and implementation screenshots were opened together at native scale. The implementation intentionally replaces long prose blocks with a stage overview, role colors, icons, and explicit active-result rows.
- Focused-region comparison evidence: the focused capture covers all execution/synthesis/audit selectors and active-result rows at readable scale.

## Findings

- No actionable P0, P1, or P2 issues remain.
- Information hierarchy: the current route appears before controls as two or three ordered cards. Users can identify the connection and model for every stage without reading explanatory paragraphs.
- Fonts and typography: existing system fonts and semibold hierarchy are preserved. Functional labels remain 11–14 px; only secondary status badges use 9–10 px text. Long provider/model names truncate instead of pushing controls out of alignment.
- Spacing and layout rhythm: the 400 px layout keeps 8–12 px gaps, compact card padding, aligned two-column selectors, and no horizontal overflow. Two-stage and three-stage workflows both fit the popup width.
- Colors and visual tokens: execution uses the product accent blue, synthesis uses restrained violet, and audit uses semantic green. All card backgrounds, borders, and muted text still reuse the product's existing surfaces and contrast hierarchy.
- Image quality and asset fidelity: the source contains no raster imagery. The implementation uses the installed Lucide icon set consistently and introduces no placeholder or handcrafted visual assets.
- Copy and content: explanatory copy was shortened to one responsibility line per stage. “实际调用/实际方式” rows expose resolved runtime behavior, including fast-model fallback, instead of leaving it inside a paragraph.
- Accessibility and interaction: the existing labeled native selects remain intact; the API management button has a readable label and icon; stage colors are reinforced by text and icons rather than carrying meaning alone.

## Interaction verification

- Opened and closed the model-plan panel from the research target settings button.
- Verified the quick-check workflow renders a two-stage execution/audit overview.
- Switched to “投研团队” and verified the three-stage execution/synthesis/audit overview and corresponding configuration cards.
- Confirmed the inner research page remains vertically scrollable and the persistent bottom navigation does not create horizontal overflow.
- Browser console errors and warnings: none.

## Comparison history

- Pass 1: replaced prose-first cards with an ordered role overview, concise responsibility headers, active-result rows, and status chips.
- Pass 2: verified both two-stage and three-stage workflow layouts at 400 × 600. No P0/P1/P2 correction was required after rendered comparison.

## Follow-up polish

- P3: provider names with unusually long custom labels rely on truncation; the native select still exposes the complete value when opened.

final result: passed

---

# Design QA — Dedicated AI connection settings

- Source visual truth: `/var/folders/mq/6n12hvnx29l_p9fv18d4dmp00000gn/T/codex-clipboard-01c99434-fdcd-439a-80b4-446f8e2a1256.png`
- Structural requirement: replace the long inline AI settings card with a settings entry card and a dedicated screen containing separate model and web-search tabs.
- Final model-tab screenshot: `/Users/yejiangyin/Desktop/资产助手/audit/ai-settings-model-tab-final.png`
- Search-tab screenshot: `/Users/yejiangyin/Desktop/资产助手/audit/ai-settings-search-tab.png`
- Full-view comparison evidence: `/Users/yejiangyin/Desktop/资产助手/audit/ai-settings-comparison-final.png`
- Focused-region comparison evidence: the comparison is cropped to the complete source card and the 400 × 600 implementation at readable scale; no additional crop was needed.
- Viewport: 400 × 600 CSS pixels.
- Theme and state: light theme; one active OpenAI connection; model list collapsed; Tavily search tab expanded.

## Findings

- No actionable P0, P1, or P2 differences remain.
- Information architecture: Settings now contains one DCA-style entry card. The dedicated page separates “大模型” and “联网搜索” into stable tabs, eliminating the previous stacked long forms.
- Fonts and typography: the existing Inter/system stack, 8–14 px compact hierarchy, semibold headings, truncation and metadata treatment match the supplied card and the rest of the extension.
- Spacing and layout rhythm: the page uses the existing 50 px header, 12 px page gutters, 8–12 px gaps, rounded cards and 58 px bottom navigation. Neither tab has horizontal overflow at popup width.
- Colors and visual tokens: all backgrounds, borders, muted text, selected-tab tint, active state and status badges use the product's existing theme tokens and semantic accent colors.
- Image quality and asset fidelity: the source contains no raster imagery. The implementation reuses the installed Lucide icon set and introduces no placeholder, handcrafted SVG, CSS drawing or unrelated visual asset.
- Copy and content: the entry card clearly names AI research connections; the dedicated header explains local storage; each tab exposes a concise current-state summary before the detailed settings.
- Accessibility: the page has a labeled tablist, selected tab state, tabpanels, an accessible back control, and the existing model accordion preserves `aria-expanded` behavior.

## Interaction verification

- Opened the AI connection entry from Settings and reached `#/settings/ai`.
- Switched between the model and web-search tabs and verified each tabpanel appeared exactly once.
- Expanded the active model connection from the collapsed list and verified the connection editor appeared.
- The search tab opens a collapsed multi-connection list by default; expanding a row edits it without changing the active connection, and the explicit “使用” action performs the switch.
- Browser console errors and warnings: none.

## Comparison history

- Pass 1: the dedicated model page opened the active connection editor immediately, creating excessive vertical density compared with the supplied list-first visual.
- Pass 2: added a dedicated-page collapsed default while preserving auto-expand in the Research Center quick settings; the final capture now matches the source's list-first hierarchy.

## Implementation checklist

- [x] Replace inline AI configuration with a Settings entry card.
- [x] Add a dedicated AI connection route and back navigation.
- [x] Separate model and web-search settings into two tabs.
- [x] Keep model connections collapsed by default and expandable on demand.
- [x] Use the same collapsed multi-connection interaction for model and search providers.
- [x] Verify 400 × 600 layout, primary interactions and console state.

## Follow-up polish

- No blocking polish remains. A future optional enhancement is to show the latest successful connection/search test time in each summary card.

final result: passed

---

# Design QA — Hybrid quality screen and compact target menu

- Structural requirement: keep AI Berkshire's quality-screen workflow while supporting either selected securities or an industry/index/theme scope.
- Viewport: 400 × 600 CSS pixels.
- Theme and state: light theme; “去劣筛选” selected; both input modes exercised.

## Findings

- “去劣筛选” now exposes an explicit two-option switch: “选择标的” and “筛选范围”. Switching modes changes the title, helper text, and input control together, so a topic field no longer looks like a broken target selector.
- The selected-security path supports one to five targets and applies the same seven hard filters to every target. The scope path accepts an industry, index, market, or investment theme for discovery.
- Switching to a scope temporarily preserves selected targets and explains that they can be recovered by switching back, preventing hidden state loss.
- The target dropdown renders the complete saved-holdings list inside a bounded 268 px scroll region; only remote market matches retain an eight-result query cap.
- At 400 px, the segmented switch, market scope, target counter, and search field align without horizontal overflow.

## Interaction verification

- Selected “去劣筛选” and confirmed the default input title is “筛选标的”.
- Switched to “筛选范围” and confirmed the target picker was replaced by a scope textarea with concrete examples.
- Switched back to “选择标的”, entered `AAPL`, and confirmed the target input retained its compact layout while searching.
- Browser console errors and warnings: none.

final result: passed

---

# Design QA — Unified and multi-target research selector

- Source visual truth: `/var/folders/mq/6n12hvnx29l_p9fv18d4dmp00000gn/T/codex-clipboard-f47874de-d129-4a35-9c5c-64e7c29ab12e.png`
- Structural requirement: remove button-like metadata tags, combine saved holdings with market search, and support researching multiple securities in one coherent flow.
- Implementation screenshot: `/Users/yejiangyin/.codex/visualizations/2026/07/15/019f63b5-94f5-7c62-bde9-e78338f0585b/research-multi-target/05-final-multi-target-cropped.png`
- Full-view comparison evidence: the source screenshot and final 400 × 600 multi-target capture were opened together in one comparison input.
- Focused-region comparison evidence: the 400 × 600 capture keeps the target selector at readable native scale, so a separate crop was not required.
- Viewport: 400 × 600 CSS pixels.
- Theme and state: light theme; two saved holdings selected; unified selector closed; multi-target comparison mode active.

## Findings

- No actionable P0, P1, or P2 differences remain.
- The former metadata pills were intentionally replaced with a single plain-text line: market, type, and currency use muted labels, stronger values, and separators without borders, fills, hover states, or selection affordances.
- Saved holdings and market search now share one input. Focusing or clicking the input opens a clearly labeled “我的持仓” section; typing continues into live market search.
- Selected targets are compact list rows rather than input values. Each row exposes correction and removal without making the metadata itself appear interactive.
- “快速检查” directly supports one to five targets, matching AI Berkshire's `investment-checklist`; multiple targets keep the same mode and add a final overview table.
- At 400 px, target names truncate safely, metadata stays on one line, controls remain aligned, and no horizontal overflow appears.
- The comparison notice clearly explains that one report will compare and rank all selected targets using the same rubric.

## Interaction verification

- Focused the empty selector and confirmed all saved holdings appeared inside the same dropdown.
- Added Apple, reopened the still-focused selector, and added a cross-market fund without leaving the field.
- Confirmed the counter changed from 0/5 to 1/5 to 2/5.
- Confirmed multiple targets remain in “快速检查”; single-target modes stay visible but are disabled with an explanatory hint until one target remains.
- Expanded correction controls for the second target and verified market, type, and currency remained independently editable.
- Removed the second target and confirmed the full single-target workflow list returned automatically.
- Browser console errors: none.

## Comparison history

- Pass 1: the unified selector worked, but clicking the still-focused search input after the first selection did not reopen saved suggestions.
- Pass 2: added click-to-reopen behavior, retained the user-selected market scope for cross-market additions, and verified the complete add/correct/remove cycle.

final result: passed

---

# Design QA — Research target selection

- Source visual truth: `/var/folders/mq/6n12hvnx29l_p9fv18d4dmp00000gn/T/codex-clipboard-abc1303e-f43e-47d2-bdee-22e8d129f693.png`
- Structural requirement: make research-target selection reuse the holding-entry search interaction, automatically fill market/type/currency, and keep those inferred fields editable.
- Implementation screenshot: `/Users/yejiangyin/.codex/visualizations/2026/07/15/019f63b5-94f5-7c62-bde9-e78338f0585b/research-target/04-final-auto-match.png`
- Correction-state screenshot: `/Users/yejiangyin/.codex/visualizations/2026/07/15/019f63b5-94f5-7c62-bde9-e78338f0585b/research-target/05-final-correction.png`
- Comparison evidence: the source screenshot and correction-state implementation were opened together in one visual comparison input.
- Viewport: 400 × 600 CSS pixels.
- Theme and state: light theme; saved Apple holding selected; market/type/currency matched to US/stock/USD; correction controls expanded.

## Findings

- No actionable P0, P1, or P2 visual differences remain.
- The old manual symbol/name/raw-code fields were intentionally replaced by the product's holding-entry market-scope and live-security-search pattern.
- Market, asset type, and currency are localized summary chips instead of raw `US`, `stock`, and an unlabeled currency field. The raw values are still preserved internally.
- The correction controls use equal-width columns, aligned labels, a shared 38 px control height, a custom centered chevron, and no horizontal overflow at 400 px.
- Empty, matched, and correction states have distinct hierarchy. The inferred metadata is visible before research begins and can be corrected without changing screens.
- Model readiness is now explicit: an unconfigured model is shown as an amber action hint and the settings button has a label, tooltip, and expanded state.

## Interaction verification

- Selecting the saved Apple holding filled the search label and automatically matched 美股 / 股票 / USD.
- Opening “修正” exposed localized market, asset-type, and quote-currency selectors; manual changes update the actual research target.
- The holdings entry sheet and research target both render the same shared live-search component.
- The research search defaults to the selected holding/seed market, reducing ambiguous cross-market matches while keeping an “全部市场” option.
- The correction panel opens and closes without moving or clipping dropdown arrows.
- Browser console errors: none.

## Comparison history

- Pass 1: shared search and automatic matching were visually aligned, but provider readiness was too ambiguous.
- Pass 2: added a clear unconfigured-model hint and accessible settings control; 400 × 600 matched and correction states passed.

final result: passed

---

# Design QA — Research report sticky header alignment

- Source visual truth: `/var/folders/mq/6n12hvnx29l_p9fv18d4dmp00000gn/T/codex-clipboard-3c85e32f-65fc-40c8-965a-71c2cd32ead6.png`
- Structural requirement: prevent the back label and download labels from collapsing vertically, and move the audit notice out of the action row.
- Implementation screenshot: `/Users/yejiangyin/Desktop/资产助手/audit/report-header-alignment-fixed.png`
- Viewport: 400 × 600 CSS pixels, matching the extension popup width shown at 2× scale in the source.
- Theme and state: light theme; report detail; one current-section download action; local-audit notice.
- Full-view comparison evidence: the source and rendered implementation were opened together. The source shows five horizontally competing items; the implementation separates controls and notice into two deliberate rows.
- Focused-region comparison evidence: the implementation screenshot keeps the complete sticky header and first report card visible at native scale, so an additional crop was unnecessary.

## Findings

- No actionable P0, P1, or P2 issues remain.
- Fonts and typography: “报告列表” and action labels now use `white-space: nowrap`; font size and weight remain consistent with the existing report screen.
- Spacing and layout rhythm: the first row uses a fixed-height back button and right-aligned action group; the audit notice occupies a full-width second row with an 8 px gap. Buttons retain consistent 32 px height and the delete button remains square.
- Colors and visual tokens: existing background, border, muted text, danger red, and backdrop-blur tokens are unchanged.
- Image quality and asset fidelity: no raster imagery is present. Existing Lucide icons are retained without replacements or handcrafted assets.
- Copy and content: no report content or action wording changed; this is a layout-only correction.
- Accessibility and interaction: accessible button names and title attributes remain intact; larger stable hit areas are preserved.

## Interaction verification

- Rendered the report detail with the no-model-audit notice at 400 × 600.
- Confirmed “报告列表” remains on one line and current/full download controls cannot collapse vertically.
- Confirmed the notice starts below the action row and spans the available width.
- Confirmed no horizontal overflow and no browser console errors or warnings.

## Comparison history

- Pass 1: changed the sticky container from one flex row to a two-level block, added a dedicated control row, and applied shrink/nowrap rules to labels and actions.
- Pass 2: rendered comparison passed without remaining P0/P1/P2 alignment issues.

final result: passed
