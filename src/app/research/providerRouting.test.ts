import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createResearchProviderProfile } from "./storage";
import { isResearchProviderConfigured, resolveResearchProviderRouting, updateWorkflowProviderRoute, workflowProviderRoute } from "./providerRouting";

describe("workflow provider routing", () => {
  const execution = createResearchProviderProfile({ id: "exec", name: "Execution", model: "research", fastModel: "fast" });
  const synthesis = createResearchProviderProfile({ id: "synth", name: "Synthesis", model: "writer" });
  const audit = createResearchProviderProfile({ id: "audit", name: "Audit", model: "reviewer" });
  const dataPro = createResearchProviderProfile({ id: "plan", name: "Agent Plan", preset: "volcengine_agent_plan", model: "plan-model", apiKey: "plan-key" });
  const collection = { activeProfileId: execution.id, profiles: [execution, synthesis, audit, dataPro] };

  test("routes one workflow across three independent API connections", () => {
    const configured = updateWorkflowProviderRoute(collection, "deep_research", {
      executionProfileId: execution.id,
      synthesisProfileId: synthesis.id,
      auditProfileId: audit.id,
    });
    const result = resolveResearchProviderRouting(configured, "deep_research");
    assert.equal(result.routing.execution.id, "exec");
    assert.equal(result.routing.synthesis.id, "synth");
    assert.equal(result.routing.audit?.id, "audit");
    assert.equal(result.snapshot.audit?.profileName, "Audit");
  });

  test("falls back to the execution API and keeps model audit opt-in", () => {
    const result = resolveResearchProviderRouting(collection, "quick_check");
    assert.equal(result.routing.synthesis.id, "exec");
    assert.equal(result.routing.executionModel, "fast");
    assert.equal(result.routing.executionModelRole, "auto");
    assert.equal(result.routing.audit, undefined);
  });

  test("allows each workflow to override automatic main/fast model selection", () => {
    const fastDeepResearch = updateWorkflowProviderRoute(collection, "deep_research", { executionModelRole: "fast" });
    const fastResult = resolveResearchProviderRouting(fastDeepResearch, "deep_research");
    assert.equal(fastResult.routing.executionModel, "fast");
    assert.equal(fastResult.snapshot.execution.modelRole, "fast");

    const mainQuickCheck = updateWorkflowProviderRoute(collection, "quick_check", { executionModelRole: "main" });
    assert.equal(resolveResearchProviderRouting(mainQuickCheck, "quick_check").routing.executionModel, "research");
  });

  test("honors an existing job snapshot when routes later change", () => {
    const changed = updateWorkflowProviderRoute(collection, "deep_research", { executionProfileId: synthesis.id });
    const result = resolveResearchProviderRouting(changed, "deep_research", {
      execution: { profileId: execution.id, profileName: execution.name },
      synthesis: { profileId: synthesis.id, profileName: synthesis.name },
      audit: { profileId: audit.id, profileName: audit.name },
    });
    assert.equal(result.routing.execution.id, "exec");
    assert.equal(result.routing.audit?.id, "audit");
  });

  test("does not add an audit API when a snapshotted job originally used local checks", () => {
    const changed = updateWorkflowProviderRoute(collection, "quick_check", { auditProfileId: audit.id });
    const result = resolveResearchProviderRouting(changed, "quick_check", {
      execution: { profileId: execution.id, profileName: execution.name },
      synthesis: { profileId: execution.id, profileName: execution.name },
      auditDisabled: true,
    });
    assert.equal(result.routing.audit, undefined);
    assert.equal(result.snapshot.auditDisabled, true);
  });

  test("accepts keyless local providers but still validates the routed model", () => {
    const local = createResearchProviderProfile({
      endpoint: "http://127.0.0.1:11434/v1",
      authMode: "none",
      apiKey: "",
      model: "llama3",
    });
    assert.equal(isResearchProviderConfigured(local, "llama3"), true);
    assert.equal(isResearchProviderConfigured(local, ""), false);
    assert.equal(isResearchProviderConfigured({ ...local, authMode: "bearer" }, "llama3"), false);
  });

  test("automatically routes DataPro through an available Agent Plan connection", () => {
    const result = resolveResearchProviderRouting(collection, "quick_check");
    assert.equal(result.routing.professionalData?.id, "plan");
    assert.equal(result.snapshot.professionalData?.profileName, "Agent Plan");
  });

  test("allows one workflow to choose a specific Agent Plan connection for DataPro", () => {
    const secondPlan = createResearchProviderProfile({ id: "plan-2", name: "Agent Plan 2", preset: "volcengine_agent_plan", model: "plan-model-2", apiKey: "plan-key-2" });
    const configured = updateWorkflowProviderRoute({ ...collection, profiles: [...collection.profiles, secondPlan] }, "quick_check", {
      professionalDataProfileId: secondPlan.id,
    });
    const result = resolveResearchProviderRouting(configured, "quick_check");
    assert.equal(result.routing.professionalData?.id, "plan-2");
    assert.equal(workflowProviderRoute(configured, "quick_check").professionalDataProfileId, "plan-2");
  });

  test("does not mutate the DataPro route of a resumed legacy job", () => {
    const result = resolveResearchProviderRouting(collection, "quick_check", {
      execution: { profileId: execution.id, profileName: execution.name },
      auditDisabled: true,
    });
    assert.equal(result.routing.professionalData, undefined);
    assert.equal(result.snapshot.professionalData, undefined);
  });
});
