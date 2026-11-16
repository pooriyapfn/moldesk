/**
 * The whole Studio page is one string so it ships inside the CLI's compiled `dist` with no
 * separate build step or static-file copy. It is a plain page: no graph framework, no bundler.
 */
export function studioPage(session: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MoleDesk Studio</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f7f7f8; --panel: #ffffff; --ink: #191a1d; --muted: #666b74;
    --line: #d9dbe0; --accent: #2457d6; --accent-ink: #ffffff; --bad: #b42318;
    --warn: #9a6700; --ok: #16794a; --code: #f0f1f4;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #15161a; --panel: #1e2026; --ink: #e8e9ec; --muted: #a1a6b0;
      --line: #333640; --accent: #7ea2ff; --accent-ink: #10131a; --bad: #ff8a80;
      --warn: #f0c36d; --ok: #6fd6a0; --code: #15171b;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif;
    background: var(--bg); color: var(--ink); }
  header { display: flex; align-items: baseline; gap: 12px; padding: 12px 16px;
    border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 2; }
  header h1 { font-size: 16px; margin: 0; }
  header .workspace { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  main { display: grid; grid-template-columns: minmax(360px, 1.1fr) minmax(340px, 0.9fr) minmax(340px, 1fr);
    gap: 12px; padding: 12px; align-items: start; }
  @media (max-width: 1100px) { main { grid-template-columns: 1fr; } }
  section.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; margin: 0 0 8px; color: var(--muted); }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
  .row:last-child { margin-bottom: 0; }
  select, input, textarea, button { font: inherit; color: inherit; }
  select, input { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
  input { width: 100%; }
  button { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px 10px; cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--accent); }
  button:disabled { opacity: .45; cursor: default; }
  button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
  textarea { width: 100%; min-height: 320px; resize: vertical; padding: 10px;
    font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code);
    color: var(--ink); border: 1px solid var(--line); border-radius: 6px; tab-size: 2; }
  label.field { display: block; margin-bottom: 8px; }
  label.field span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 3px; }
  .diagnostics { min-height: 1.5em; margin: 8px 0; }
  .diagnostic { border-left: 3px solid var(--bad); padding: 4px 8px; margin-bottom: 4px;
    background: color-mix(in srgb, var(--bad) 8%, transparent); font-size: 12px; }
  .diagnostic code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .diagnostic .where { color: var(--muted); }
  .muted { color: var(--muted); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .dag { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
  .node { text-align: left; width: 100%; border-left: 4px solid var(--line); }
  .node.selected { border-left-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, var(--panel)); }
  .node .meta { color: var(--muted); font-size: 12px; }
  .edge-list { color: var(--muted); font-size: 12px; margin-bottom: 10px; }
  .inspector { border-top: 1px solid var(--line); padding-top: 8px; }
  .kv { display: grid; grid-template-columns: max-content 1fr; gap: 3px 10px; font-size: 12px; }
  .kv dt { color: var(--muted); }
  .kv dd { margin: 0; overflow-wrap: anywhere; }
  .badge { display: inline-block; border: 1px solid var(--line); border-radius: 999px;
    padding: 0 7px; font-size: 11px; margin-right: 4px; white-space: nowrap; }
  .badge.ok { color: var(--ok); border-color: var(--ok); }
  .badge.bad { color: var(--bad); border-color: var(--bad); }
  .badge.warn { color: var(--warn); border-color: var(--warn); }
  ul.steps { list-style: none; padding: 0; margin: 0 0 10px; }
  ul.steps li { border-top: 1px solid var(--line); padding: 6px 0; }
  ul.steps li:first-child { border-top: 0; }
  .artifact { display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
    border-top: 1px solid var(--line); padding: 6px 0; }
  .artifact:first-child { border-top: 0; }
  .artifact a { color: var(--accent); }
  details.logs { margin-top: 6px; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--code);
    border: 1px solid var(--line); border-radius: 6px; padding: 8px; max-height: 220px; overflow: auto; }
  .empty { color: var(--muted); font-size: 12px; }
  .error { color: var(--bad); white-space: pre-wrap; }
</style>
</head>
<body>
<header>
  <h1>MoleDesk Studio</h1>
  <div class="workspace" id="workspace">Loading workspace…</div>
</header>
<main>
  <section class="panel">
    <div class="row">
      <select id="workspaceFiles" aria-label="Workspace YAML files"><option value="">Open workspace YAML…</option></select>
      <button id="download" title="Download the edited draft">Download draft</button>
    </div>
    <h2>Workflow draft</h2>
    <textarea id="yaml" spellcheck="false" aria-label="Workflow YAML"></textarea>
    <div id="diagnostics" class="diagnostics"></div>
    <div id="inputs"></div>
    <div class="row">
      <button id="validate">Validate</button>
      <button id="plan" class="primary">Plan</button>
    </div>
  </section>

  <section class="panel">
    <div class="row"><h2>Plan</h2><span id="planMeta" class="muted mono"></span></div>
    <div id="dag" class="dag"><div class="empty">Validate the draft, fill the inputs, then plan.</div></div>
    <div id="planDetails"></div>
    <div id="approvalBox" class="inspector" hidden>
      <h2>Approval</h2>
      <div class="muted">Studio cannot approve a plan. Review it and approve in a terminal, then paste the returned approvalId:</div>
      <div class="row"><pre id="approveCommand" class="mono"></pre><button id="copyCommand" type="button">Copy command</button></div>
      <label class="field"><span>approvalId (one use)</span><input id="approvalId" autocomplete="off" spellcheck="false" placeholder="Paste the approvalId printed by the command"></label>
    </div>
    <div id="nodeInspector" class="inspector"></div>
  </section>

  <section class="panel">
    <div class="row">
      <h2>Run</h2>
      <button id="run" class="primary" disabled>Run</button>
      <button id="cancel" disabled>Cancel</button>
      <button id="resume" disabled>Resume</button>
    </div>
    <div id="runMeta" class="empty">No run yet.</div>
    <ul id="steps" class="steps"></ul>
    <div id="artifacts"></div>
    <div id="logs"></div>
  </section>
</main>
<script>
"use strict";
const SESSION = ${JSON.stringify(session)};
const state = { plan: null, declarations: [], selectedStep: null, runId: null, source: null, runActive: false };

const $ = (id) => document.getElementById(id);
const text = (tag, value, className) => {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = String(value);
  if (className) node.className = className;
  return node;
};
const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); };

function api(path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("x-studio-session", SESSION);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(path, { ...init, headers });
}

async function apiJson(path, init) {
  const response = await api(path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.remediation || ("HTTP " + response.status));
  return body;
}

function diagnosticList(list) {
  const root = $("diagnostics");
  clear(root);
  for (const item of list || []) {
    const box = text("div", undefined, "diagnostic");
    const where = item.line === undefined ? item.path : item.path + ":" + item.line + ":" + (item.column || 1);
    box.append(text("span", where + " ", "where"));
    box.append(text("code", item.code));
    box.append(document.createTextNode(" " + item.message));
    root.append(box);
  }
}

function updateRunButton() {
  $("run").disabled = !(state.plan && $("approvalId").value.trim() && !state.runActive);
}

function clearPlan() {
  state.plan = null;
  state.selectedStep = null;
  $("approvalId").value = "";
  renderPlan();
}

function setDraft(value) {
  $("yaml").value = value;
  clearPlan();
  diagnosticList([]);
}

function collectInputs() {
  const values = {};
  for (const field of document.querySelectorAll("[data-input-name]")) {
    values[field.dataset.inputName] = field.value;
  }
  return values;
}

function renderInputs(declarations) {
  const root = $("inputs");
  const previous = collectInputs();
  clear(root);
  if (!declarations || declarations.length === 0) return;
  root.append(text("h2", "Inputs"));
  for (const declaration of declarations) {
    const label = text("label", undefined, "field");
    const caption = text("span", declaration.name + (declaration.required ? " (required)" : "") + " · " + declaration.type);
    const input = text("input");
    input.dataset.inputName = declaration.name;
    input.placeholder = declaration.type === "protein_sequence" ? "Amino-acid sequence" : "Workspace-relative or absolute file path";
    input.autocomplete = "off";
    if (Object.prototype.hasOwnProperty.call(previous, declaration.name)) input.value = previous[declaration.name];
    input.addEventListener("input", () => clearPlan());
    label.append(caption, input);
    root.append(label);
  }
}

async function validateDraft() {
  try {
    const result = await apiJson("/api/validate", { method: "POST", body: JSON.stringify({ source: $("yaml").value }) });
    diagnosticList(result.diagnostics);
    state.declarations = result.inputs || [];
    renderInputs(state.declarations);
    if (result.valid) {
      $("diagnostics").append(text("div", "Workflow validates. Step order: " + (result.order || []).join(" → "), "muted"));
    } else {
      clearPlan();
    }
    return result;
  } catch (error) {
    diagnosticList([{ path: "$", code: "REQUEST_FAILED", message: String(error.message || error) }]);
    clearPlan();
    return null;
  }
}

async function planDraft() {
  $("plan").disabled = true;
  try {
    const result = await apiJson("/api/plan", {
      method: "POST",
      body: JSON.stringify({ source: $("yaml").value, inputs: collectInputs() })
    });
    diagnosticList(result.diagnostics);
    if (!result.valid || !result.plan) {
      clearPlan();
      return;
    }
    state.plan = result.plan;
    state.selectedStep = result.plan.steps[0] ? result.plan.steps[0].id : null;
    renderPlan();
  } catch (error) {
    diagnosticList([{ path: "$", code: "REQUEST_FAILED", message: String(error.message || error) }]);
    clearPlan();
  } finally {
    $("plan").disabled = false;
  }
}

function renderPlan() {
  const plan = state.plan;
  updateRunButton();
  $("approvalBox").hidden = !plan;
  $("approveCommand").textContent = plan ? "moldesk workflow approve " + plan.planId + " --json" : "";
  clear($("dag"));
  clear($("planDetails"));
  clear($("nodeInspector"));
  $("planMeta").textContent = plan ? "plan " + plan.planId : "";
  if (!plan) {
    $("dag").append(text("div", "Validate the draft, fill the inputs, then plan.", "empty"));
    return;
  }
  plan.steps.forEach((step, index) => {
    if (index > 0) {
      const arrow = text("div", "↓", "muted");
      arrow.style.paddingLeft = "12px";
      $("dag").append(arrow);
    }
    const node = text("button", undefined, "node" + (state.selectedStep === step.id ? " selected" : ""));
    node.type = "button";
    node.append(text("div", step.id));
    node.append(text("div", step.uses + " · v" + step.operationVersion, "meta"));
    node.addEventListener("click", () => { state.selectedStep = step.id; renderPlan(); });
    $("dag").append(node);
  });
  const edges = plan.edges.length === 0 ? "no edges" : plan.edges.map((edge) => edge.from + " → " + edge.to).join(", ");
  $("planDetails").append(text("div", "Edges: " + edges, "edge-list"));
  const backend = plan.requirements.map((req) => req.stepId + ": " + req.backend + (req.model ? " · " + req.model.name : "")).join(" | ");
  $("planDetails").append(text("div", "Backend: " + backend, "edge-list"));
  const table = document.createElement("dl");
  table.className = "kv";
  for (const [name, input] of Object.entries(plan.inputs)) {
    table.append(text("dt", name));
    const detail = input.format ? " (" + input.format + ", " + input.sizeBytes + " bytes, sha256 " + input.sha256.slice(0, 12) + "…)" : "";
    table.append(text("dd", String(input.value) + detail));
  }
  $("planDetails").append(table);
  renderInspector();
}

function renderInspector() {
  const root = $("nodeInspector");
  clear(root);
  const step = state.plan && state.plan.steps.find((item) => item.id === state.selectedStep);
  if (!step) return;
  root.append(text("h2", "Node " + step.id));
  const table = document.createElement("dl");
  table.className = "kv";
  const add = (key, value) => { table.append(text("dt", key)); table.append(text("dd", value)); };
  add("uses", step.uses);
  add("version", String(step.operationVersion));
  add("needs", step.needs.length ? step.needs.join(", ") : "—");
  add("bindings", step.bindings.map((binding) => binding.input + " = " + renderBinding(binding.source)).join("; ") || "—");
  add("outputs", step.outputs.map((output) => output.name + ": " + output.type).join("; ") || "—");
  const requirement = state.plan.requirements.find((item) => item.stepId === step.id);
  if (requirement) add("backend", requirement.backend + (requirement.model ? " · " + requirement.model.name + " " + requirement.model.modelVersion : ""));
  root.append(table);
}

function renderBinding(source) {
  if (!source) return "";
  return source.kind === "input" ? "\${inputs." + source.name + "}" : "\${steps." + source.stepId + ".outputs." + source.output + "}";
}

async function startRun() {
  const approvalId = $("approvalId").value.trim();
  if (!state.plan || !approvalId) return;
  $("run").disabled = true;
  try {
    const result = await apiJson("/api/runs", { method: "POST", body: JSON.stringify({ approvalId }) });
    $("approvalId").value = "";
    state.runId = result.runId;
    renderRun({ runStatus: "queued", steps: [], artifacts: [], logs: {}, events: [] });
    connectEvents();
    await refreshRun();
  } catch (error) {
    renderRunError(error);
    updateRunButton();
  }
}

function connectEvents() {
  if (state.source) state.source.close();
  if (!state.runId) return;
  const source = new EventSource("/api/runs/" + encodeURIComponent(state.runId) + "/events?session=" + encodeURIComponent(SESSION));
  state.source = source;
  source.onopen = () => { refreshRun().catch(() => {}); };
  source.addEventListener("snapshot", (event) => {
    try { renderRun(JSON.parse(event.data)); } catch { refreshRun().catch(() => {}); }
  });
  source.addEventListener("workflow", () => { refreshRun().catch(() => {}); });
  source.addEventListener("end", () => { refreshRun().catch(() => {}); source.close(); });
  source.onerror = () => { refreshRun().catch(() => {}); };
}

async function refreshRun() {
  if (!state.runId) return;
  try {
    const snapshot = await apiJson("/api/runs/" + encodeURIComponent(state.runId));
    renderRun(snapshot);
  } catch (error) {
    renderRunError(error);
  }
}

function statusBadge(value) {
  const status = String(value || "unknown");
  const kind = status === "succeeded" ? "ok" : (status === "failed" || status === "cancelled" || status === "interrupted") ? "bad" : (status === "running" || status === "queued" ? "warn" : "");
  const badge = text("span", status, "badge " + kind);
  return badge;
}

function renderRun(snapshot) {
  const meta = $("runMeta");
  clear(meta);
  meta.className = "";
  if (!snapshot || !snapshot.runId) { meta.className = "empty"; meta.textContent = "No run yet."; return; }
  meta.append(statusBadge(snapshot.runStatus || snapshot.status));
  meta.append(text("span", " " + snapshot.runId, "mono"));
  if (snapshot.error) meta.append(text("div", snapshot.error.code + ": " + snapshot.error.message, "error"));
  const terminal = ["succeeded", "failed", "cancelled", "interrupted"].includes(snapshot.runStatus || snapshot.status);
  $("cancel").disabled = terminal;
  $("resume").disabled = !(snapshot.runStatus === "interrupted" || snapshot.runStatus === "failed");
  state.runActive = !terminal;
  updateRunButton();

  const steps = $("steps");
  clear(steps);
  for (const step of snapshot.steps || []) {
    const item = text("li");
    item.append(statusBadge(step.status));
    item.append(text("strong", " " + step.id));
    item.append(text("span", " · " + step.uses + " · attempt " + step.attempt, "muted"));
    if (step.childRunId) item.append(text("div", "child run " + step.childRunId, "mono muted"));
    if (step.error) item.append(text("div", step.error.code + ": " + step.error.message, "error"));
    steps.append(item);
  }

  const artifacts = $("artifacts");
  clear(artifacts);
  if ((snapshot.artifacts || []).length > 0) {
    artifacts.append(text("h2", "Artifacts"));
    for (const artifact of snapshot.artifacts) {
      const row = text("div", undefined, "artifact");
      row.append(statusBadge(artifact.verified ? "verified" : "unverified"));
      row.append(text("span", artifact.id + " · " + artifact.type + " · " + artifact.format, "mono"));
      if (artifact.verified) {
        const link = document.createElement("a");
        link.href = "/api/runs/" + encodeURIComponent(snapshot.runId) + "/artifacts/" + encodeURIComponent(artifact.id) + "?session=" + encodeURIComponent(SESSION);
        link.textContent = "Download";
        link.setAttribute("download", artifact.id + "." + artifact.format);
        row.append(link);
        if (artifact.type === "protein_structure") {
          const preview = document.createElement("a");
          preview.href = "/api/runs/" + encodeURIComponent(snapshot.runId) + "/artifacts/" + encodeURIComponent(artifact.id) + "/preview?session=" + encodeURIComponent(SESSION);
          preview.target = "_blank";
          preview.rel = "noopener";
          preview.textContent = "Open structure preview";
          row.append(preview);
        }
      }
      artifacts.append(row);
    }
  }

  const logs = $("logs");
  clear(logs);
  const entries = Object.entries(snapshot.logs || {});
  if (entries.length > 0) {
    logs.append(text("h2", "Model logs"));
    for (const [stepId, tail] of entries) {
      const details = document.createElement("details");
      details.className = "logs";
      details.append(text("summary", stepId + (tail.childRunId ? " · " + tail.childRunId : "")));
      if (tail.stdout) details.append(text("pre", tail.stdout));
      if (tail.stderr) details.append(text("pre", tail.stderr));
      if (!tail.stdout && !tail.stderr) details.append(text("div", "No log output yet.", "empty"));
      logs.append(details);
    }
  }
}

function renderRunError(error) {
  const meta = $("runMeta");
  clear(meta);
  meta.className = "error";
  meta.textContent = String(error.message || error);
}

async function cancelRun() {
  if (!state.runId) return;
  try {
    await apiJson("/api/runs/" + encodeURIComponent(state.runId) + "/cancel", { method: "POST", body: "{}" });
    await refreshRun();
  } catch (error) { renderRunError(error); }
}

async function resumeRun() {
  if (!state.runId) return;
  try {
    await apiJson("/api/runs/" + encodeURIComponent(state.runId) + "/resume", { method: "POST", body: "{}" });
    connectEvents();
    await refreshRun();
  } catch (error) { renderRunError(error); }
}

async function loadWorkspace() {
  try {
    const body = await apiJson("/api/workspace");
    $("workspace").textContent = body.workspaceRoot;
    const select = $("workspaceFiles");
    for (const file of body.files || []) {
      const option = document.createElement("option");
      option.value = file.path;
      option.textContent = file.path + " (" + file.sizeBytes + " bytes)";
      select.append(option);
    }
  } catch (error) {
    $("workspace").textContent = "Workspace unavailable: " + String(error.message || error);
  }
}

async function openWorkspaceFile(file) {
  if (!file) return;
  try {
    const body = await apiJson("/api/file?path=" + encodeURIComponent(file));
    setDraft(body.content);
    $("workspaceFiles").value = file;
    await validateDraft();
  } catch (error) {
    diagnosticList([{ path: "$", code: "FILE_READ_FAILED", message: String(error.message || error) }]);
  }
}

function downloadDraft() {
  const blob = new Blob([$("yaml").value], { type: "application/yaml" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "workflow.yaml";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

$("yaml").addEventListener("input", () => { clearPlan(); });
$("validate").addEventListener("click", () => { validateDraft(); });
$("plan").addEventListener("click", () => { planDraft(); });
$("run").addEventListener("click", () => { startRun(); });
$("approvalId").addEventListener("input", updateRunButton);
$("copyCommand").addEventListener("click", () => {
  const command = $("approveCommand").textContent;
  if (navigator.clipboard) navigator.clipboard.writeText(command).catch(() => {});
});
$("cancel").addEventListener("click", () => { cancelRun(); });
$("resume").addEventListener("click", () => { resumeRun(); });
$("download").addEventListener("click", downloadDraft);
$("workspaceFiles").addEventListener("change", (event) => { openWorkspaceFile(event.target.value); });
loadWorkspace();
</script>
</body>
</html>
`;
}
