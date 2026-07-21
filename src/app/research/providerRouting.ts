import type {
  ResearchProviderCollection,
  ResearchProviderSettings,
  ResearchProviderRouteSnapshot,
  ResearchRunProviderRouting,
  ResearchWorkflowId,
  ResearchWorkflowProviderRoute,
} from "./types";
import { getWorkflowConfig } from "./workflows/registry";

function findProfile(collection: ResearchProviderCollection, profileId?: string) {
  return collection.profiles.find((profile) => profile.id === profileId);
}

export function isResearchProviderConfigured(profile: ResearchProviderSettings | null | undefined, model?: string) {
  if (!profile?.endpoint.trim()) return false;
  if (!(model ?? profile.model).trim()) return false;
  return profile.authMode === "none" || Boolean(profile.apiKey.trim());
}

export function workflowProviderRoute(
  collection: ResearchProviderCollection,
  workflowId: ResearchWorkflowId,
): ResearchWorkflowProviderRoute {
  return collection.workflowRoutes?.[workflowId] ?? {};
}

export function resolveResearchProviderRouting(
  collection: ResearchProviderCollection,
  workflowId: ResearchWorkflowId,
  snapshot?: ResearchProviderRouteSnapshot,
): { routing: ResearchRunProviderRouting; snapshot: ResearchProviderRouteSnapshot } {
  const configured = workflowProviderRoute(collection, workflowId);
  const workflow = getWorkflowConfig(workflowId);
  const defaultProfile = findProfile(collection, collection.activeProfileId) ?? collection.profiles[0];
  if (!defaultProfile) throw new Error("没有可用的大模型 API 连接");

  const execution = findProfile(collection, snapshot?.execution.profileId)
    ?? findProfile(collection, configured.executionProfileId)
    ?? defaultProfile;
  const synthesis = findProfile(collection, snapshot?.synthesis?.profileId)
    ?? findProfile(collection, configured.synthesisProfileId)
    ?? execution;
  const executionModelRole = snapshot?.execution.modelRole ?? configured.executionModelRole ?? "auto";
  const executionModel = snapshot?.execution.model || (
    executionModelRole === "main"
      ? execution.model
      : executionModelRole === "fast"
        ? execution.fastModel || execution.model
        : workflow.useFullModel ? execution.model : execution.fastModel || execution.model
  );
  const synthesisModel = snapshot?.synthesis?.model || synthesis.synthesisModel || synthesis.model;

  // A job snapshot is authoritative: if it did not include an audit provider,
  // resuming it must not silently pick up a route configured later.
  const auditDisabled = snapshot
    ? Boolean(snapshot.auditDisabled || !snapshot.audit)
    : Boolean(configured.auditDisabled);
  const explicitlyRoutedAudit = Boolean(snapshot?.audit?.profileId || configured.auditProfileId);
  const auditCandidate = auditDisabled
    ? undefined
    : findProfile(collection, snapshot?.audit?.profileId)
      ?? findProfile(collection, configured.auditProfileId)
      ?? execution;
  const audit = auditCandidate && (explicitlyRoutedAudit || Boolean(auditCandidate.auditModel))
    ? auditCandidate
    : undefined;
  const auditModel = snapshot?.audit?.model || audit?.auditModel || audit?.model;
  // Keep resumed jobs reproducible. A stored route snapshot is authoritative,
  // including the absence of DataPro on jobs created before it was enabled.
  const configuredProfessionalData = findProfile(collection, configured.professionalDataProfileId);
  const professionalData = snapshot
    ? findProfile(collection, snapshot.professionalData?.profileId)
    : (configuredProfessionalData?.preset === "volcengine_agent_plan" ? configuredProfessionalData : undefined)
      ?? (execution.preset === "volcengine_agent_plan" ? execution : undefined)
      ?? (defaultProfile.preset === "volcengine_agent_plan" ? defaultProfile : undefined)
      ?? collection.profiles.find((profile) => profile.preset === "volcengine_agent_plan");

  return {
    routing: {
      execution,
      executionModel,
      executionModelRole,
      synthesis,
      synthesisModel,
      audit,
      auditModel,
      professionalData,
    },
    snapshot: {
      execution: {
        profileId: execution.id,
        profileName: execution.name,
        model: executionModel,
        modelRole: executionModelRole,
      },
      ...(workflow.needsSynthesis ? {
        synthesis: {
          profileId: synthesis.id,
          profileName: synthesis.name,
          model: synthesisModel,
        },
      } : {}),
      ...(audit ? {
        audit: {
          profileId: audit.id,
          profileName: audit.name,
          model: auditModel,
        },
      } : {}),
      ...(professionalData ? {
        professionalData: {
          profileId: professionalData.id,
          profileName: professionalData.name,
        },
      } : {}),
      ...(!audit ? { auditDisabled: true } : {}),
    },
  };
}

export function updateWorkflowProviderRoute(
  collection: ResearchProviderCollection,
  workflowId: ResearchWorkflowId,
  changes: Partial<ResearchWorkflowProviderRoute>,
): ResearchProviderCollection {
  const current = workflowProviderRoute(collection, workflowId);
  const next = { ...current, ...changes };
  const compact: ResearchWorkflowProviderRoute = {
    ...(next.executionProfileId ? { executionProfileId: next.executionProfileId } : {}),
    ...(next.executionModelRole && next.executionModelRole !== "auto" ? { executionModelRole: next.executionModelRole } : {}),
    ...(next.synthesisProfileId ? { synthesisProfileId: next.synthesisProfileId } : {}),
    ...(next.auditProfileId ? { auditProfileId: next.auditProfileId } : {}),
    ...(next.auditDisabled ? { auditDisabled: true } : {}),
    ...(next.professionalDataProfileId ? { professionalDataProfileId: next.professionalDataProfileId } : {}),
  };
  const workflowRoutes = { ...(collection.workflowRoutes ?? {}) };
  if (Object.keys(compact).length) workflowRoutes[workflowId] = compact;
  else delete workflowRoutes[workflowId];
  return { ...collection, workflowRoutes };
}
