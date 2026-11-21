import type { SupabaseClient } from "@supabase/supabase-js";
import {
  normalizeSceneSettings,
  parseVec3,
  type SeeAnnotation,
  type SeeFile,
  type SeeProject,
  type SeeProjectAggregate,
  type SeeProjectListQuery,
  type SeeProjectSummary,
  type SeePublication,
  type SeeScene,
  type SeeSnapshot,
} from "../../domain/seeProject.ts";
import type { SeeAccessGrant, SeeRepository, SeeViewInput } from "./repository.ts";

type Row = Record<string, unknown>;

const optional = <T>(value: T | null | undefined): T | undefined => (value === null ? undefined : value);

function check<T>(result: { data: T; error: unknown }): T {
  if (result.error) throw result.error;
  return result.data;
}

function stamp(id: unknown, label: unknown) {
  return typeof id === "string" ? { id, label: typeof label === "string" && label ? label : id } : undefined;
}

export function rowToProject(row: Row): SeeProject {
  return {
    id: row.id as string,
    name: row.name as string,
    description: (row.description as string) ?? "",
    status: row.status as SeeProject["status"],
    createdAt: row.created_at as string,
    createdBy: stamp(row.created_by, row.created_by_label),
    updatedAt: row.updated_at as string,
    updatedBy: stamp(row.updated_by, row.updated_by_label),
    deletedAt: optional(row.deleted_at as string | null),
  };
}

function projectToRow(project: SeeProject) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status,
    created_by: project.createdBy?.id ?? null,
    created_by_label: project.createdBy?.label ?? null,
    updated_by: project.updatedBy?.id ?? null,
    updated_by_label: project.updatedBy?.label ?? null,
    deleted_at: project.deletedAt ?? null,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
  };
}

function rowToScene(row: Row): SeeScene {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    name: row.name as string,
    description: (row.description as string) ?? "",
    sortOrder: row.sort_order as number,
    modelFileId: optional(row.model_file_id as string | null),
    settings: normalizeSceneSettings(row.settings),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function sceneToRow(scene: SeeScene) {
  return {
    id: scene.id,
    project_id: scene.projectId,
    name: scene.name,
    description: scene.description,
    sort_order: scene.sortOrder,
    model_file_id: scene.modelFileId ?? null,
    settings: scene.settings,
  };
}

function rowToAnnotation(row: Row): SeeAnnotation {
  return {
    id: row.id as string,
    sceneId: row.scene_id as string,
    title: row.title as string,
    body: (row.body as string) ?? "",
    position: parseVec3(row.position) ?? [0, 0, 0],
    normal: parseVec3(row.normal),
    visible: row.visible as boolean,
    sortOrder: row.sort_order as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function annotationToRow(annotation: SeeAnnotation) {
  return {
    id: annotation.id,
    scene_id: annotation.sceneId,
    title: annotation.title,
    body: annotation.body,
    position: annotation.position,
    normal: annotation.normal ?? null,
    visible: annotation.visible,
    sort_order: annotation.sortOrder,
  };
}

function rowToFile(row: Row, sceneIds: readonly string[]): SeeFile {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    kind: row.kind as SeeFile["kind"],
    displayName: row.display_name as string,
    originalFileName: row.original_file_name as string,
    mimeType: row.mime_type as string,
    sizeBytes: Number(row.size_bytes),
    storageKey: row.storage_key as string,
    status: row.status as SeeFile["status"],
    appliesToAll: row.applies_to_all as boolean,
    sceneIds,
    sortOrder: row.sort_order as number,
    modelInfo: optional(row.model_info as SeeFile["modelInfo"] | null),
    createdBy: optional(row.created_by as string | null),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    deletedAt: optional(row.deleted_at as string | null),
  };
}

function fileToRow(file: SeeFile) {
  return {
    id: file.id,
    project_id: file.projectId,
    kind: file.kind,
    display_name: file.displayName,
    original_file_name: file.originalFileName,
    mime_type: file.mimeType,
    size_bytes: file.sizeBytes,
    storage_key: file.storageKey,
    status: file.status,
    applies_to_all: file.appliesToAll,
    sort_order: file.sortOrder,
    model_info: file.modelInfo ?? null,
    created_by: file.createdBy ?? null,
    deleted_at: file.deletedAt ?? null,
  };
}

function rowToPublication(row: Row): SeePublication {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    shareSlug: row.share_slug as string,
    mode: row.mode as SeePublication["mode"],
    status: row.status as SeePublication["status"],
    pinHash: optional(row.pin_hash as string | null),
    pinSetAt: optional(row.pin_set_at as string | null),
    accessEpoch: row.access_epoch as number,
    snapshot: optional(row.snapshot as SeeSnapshot | null),
    snapshotRevision: row.snapshot_revision as number,
    viewCount: row.view_count as number,
    lastViewedAt: optional(row.last_viewed_at as string | null),
    embedPolicy: (row.embed_policy as SeePublication["embedPolicy"]) ?? "default",
    embedOrigins: Array.isArray(row.embed_origins) ? row.embed_origins as string[] : [],
    publishedAt: optional(row.published_at as string | null),
    publishedBy: optional(row.published_by as string | null),
    unpublishedAt: optional(row.unpublished_at as string | null),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function publicationToRow(publication: SeePublication) {
  return {
    id: publication.id,
    project_id: publication.projectId,
    share_slug: publication.shareSlug,
    mode: publication.mode,
    status: publication.status,
    pin_hash: publication.pinHash ?? null,
    pin_set_at: publication.pinSetAt ?? null,
    access_epoch: publication.accessEpoch,
    snapshot: publication.snapshot ?? null,
    snapshot_revision: publication.snapshotRevision,
    embed_policy: publication.embedPolicy,
    embed_origins: [...publication.embedOrigins],
    published_at: publication.publishedAt ?? null,
    published_by: publication.publishedBy ?? null,
    unpublished_at: publication.unpublishedAt ?? null,
  };
}

const PUBLICATION_LIST_COLUMNS = "project_id, share_slug, mode, status, published_at, view_count, last_viewed_at";

/** Server-only (service-role client). Touches exclusively the `see_*` tables. */
export class SupabaseSeeRepository implements SeeRepository {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async listProjects(query: SeeProjectListQuery) {
    let request = this.client.from("see_projects").select("*", { count: "exact" });
    request = query.status && query.status !== "all" ? request.eq("status", query.status) : request.neq("status", "deleted");
    const search = query.search?.trim().replace(/[%_,()\\]/gu, " ").slice(0, 100);
    if (search) request = request.or(`name.ilike.%${search}%,description.ilike.%${search}%`);
    if (query.publication && query.publication !== "all") {
      const published = check(await this.client.from("see_publications").select("project_id").eq("status", "published")) as Row[];
      const ids = published.map((row) => row.project_id as string);
      if (query.publication === "published") {
        if (!ids.length) return { items: [], total: 0 };
        request = request.in("id", ids);
      } else if (ids.length) {
        request = request.not("id", "in", `(${ids.join(",")})`);
      }
    }
    const result = await request.order("updated_at", { ascending: false }).range(query.offset, query.offset + query.limit - 1);
    const rows = check(result) as Row[];
    const ids = rows.map((row) => row.id as string);
    if (!ids.length) return { items: [], total: result.count ?? 0 };
    const [scenes, files, publications] = await Promise.all([
      this.client.from("see_scenes").select("project_id").in("project_id", ids),
      this.client.from("see_files").select("project_id").in("project_id", ids).eq("kind", "document").eq("status", "ready").is("deleted_at", null),
      this.client.from("see_publications").select(PUBLICATION_LIST_COLUMNS).in("project_id", ids),
    ]);
    const count = (list: Row[], id: string) => list.filter((row) => row.project_id === id).length;
    const sceneRows = check(scenes) as Row[];
    const fileRows = check(files) as Row[];
    const publicationRows = check(publications) as Row[];
    const items: SeeProjectSummary[] = rows.map((row) => {
      const publication = publicationRows.find((entry) => entry.project_id === row.id);
      return {
        project: rowToProject(row),
        sceneCount: count(sceneRows, row.id as string),
        documentCount: count(fileRows, row.id as string),
        publication: publication && {
          shareSlug: publication.share_slug as string,
          mode: publication.mode as SeePublication["mode"],
          status: publication.status as SeePublication["status"],
          publishedAt: optional(publication.published_at as string | null),
          viewCount: publication.view_count as number,
          lastViewedAt: optional(publication.last_viewed_at as string | null),
        },
      };
    });
    return { items, total: result.count ?? items.length };
  }

  async getProject(projectId: string) {
    const row = check(await this.client.from("see_projects").select("*").eq("id", projectId).maybeSingle()) as Row | null;
    return row ? rowToProject(row) : undefined;
  }

  async getAggregate(projectId: string): Promise<SeeProjectAggregate | undefined> {
    const project = await this.getProject(projectId);
    if (!project) return undefined;
    const [scenes, files, publication] = await Promise.all([
      this.client.from("see_scenes").select("*").eq("project_id", projectId).order("sort_order"),
      this.client.from("see_files").select("*").eq("project_id", projectId).order("sort_order").order("created_at"),
      this.client.from("see_publications").select("*").eq("project_id", projectId).maybeSingle(),
    ]);
    const sceneRows = check(scenes) as Row[];
    const fileRows = check(files) as Row[];
    const sceneIds = sceneRows.map((row) => row.id as string);
    const fileIds = fileRows.map((row) => row.id as string);
    const [annotations, links] = await Promise.all([
      sceneIds.length ? this.client.from("see_annotations").select("*").in("scene_id", sceneIds).order("sort_order") : Promise.resolve({ data: [], error: null }),
      fileIds.length ? this.client.from("see_file_scene_links").select("file_id, scene_id").in("file_id", fileIds) : Promise.resolve({ data: [], error: null }),
    ]);
    const linkRows = check(links) as Row[];
    const publicationRow = check(publication) as Row | null;
    return {
      project,
      scenes: sceneRows.map(rowToScene),
      annotations: (check(annotations) as Row[]).map(rowToAnnotation),
      files: fileRows.map((row) => rowToFile(row, linkRows.filter((link) => link.file_id === row.id).map((link) => link.scene_id as string))),
      publication: publicationRow ? rowToPublication(publicationRow) : undefined,
    };
  }

  async insertProject(project: SeeProject) {
    check(await this.client.from("see_projects").insert(projectToRow(project)));
  }

  async updateProject(project: SeeProject) {
    const { id, created_at: _createdAt, created_by: _createdBy, created_by_label: _createdByLabel, updated_at: _updatedAt, ...changes } = projectToRow(project);
    check(await this.client.from("see_projects").update(changes).eq("id", id));
  }

  async insertScene(scene: SeeScene) {
    check(await this.client.from("see_scenes").insert(sceneToRow(scene)));
  }

  async updateScene(scene: SeeScene) {
    const { id, project_id: _projectId, ...changes } = sceneToRow(scene);
    check(await this.client.from("see_scenes").update(changes).eq("id", id));
  }

  async deleteScene(sceneId: string) {
    check(await this.client.from("see_scenes").delete().eq("id", sceneId));
  }

  async insertAnnotation(annotation: SeeAnnotation) {
    check(await this.client.from("see_annotations").insert(annotationToRow(annotation)));
  }

  async updateAnnotation(annotation: SeeAnnotation) {
    const { id, scene_id: _sceneId, ...changes } = annotationToRow(annotation);
    check(await this.client.from("see_annotations").update(changes).eq("id", id));
  }

  async deleteAnnotation(annotationId: string) {
    check(await this.client.from("see_annotations").delete().eq("id", annotationId));
  }

  async getFile(fileId: string) {
    const row = check(await this.client.from("see_files").select("*").eq("id", fileId).maybeSingle()) as Row | null;
    if (!row) return undefined;
    const links = check(await this.client.from("see_file_scene_links").select("scene_id").eq("file_id", fileId)) as Row[];
    return rowToFile(row, links.map((link) => link.scene_id as string));
  }

  async insertFile(file: SeeFile) {
    check(await this.client.from("see_files").insert(fileToRow(file)));
    await this.replaceLinks(file);
  }

  async updateFile(file: SeeFile) {
    const { id, project_id: _projectId, storage_key: _storageKey, created_by: _createdBy, ...changes } = fileToRow(file);
    check(await this.client.from("see_files").update(changes).eq("id", id));
    await this.replaceLinks(file);
  }

  async updateFileStorageKey(fileId: string, storageKey: string, expectedKey: string) {
    const rows = check(await this.client.from("see_files").update({ storage_key: storageKey }).eq("id", fileId).eq("storage_key", expectedKey).select("id")) as Row[] | null;
    return Array.isArray(rows) && rows.length === 1;
  }

  private async replaceLinks(file: SeeFile) {
    check(await this.client.from("see_file_scene_links").delete().eq("file_id", file.id));
    const sceneIds = file.appliesToAll ? [] : [...new Set(file.sceneIds)];
    if (sceneIds.length) {
      check(await this.client.from("see_file_scene_links").insert(sceneIds.map((sceneId) => ({ file_id: file.id, scene_id: sceneId }))));
    }
  }

  async getPublicationByProject(projectId: string) {
    const row = check(await this.client.from("see_publications").select("*").eq("project_id", projectId).maybeSingle()) as Row | null;
    return row ? rowToPublication(row) : undefined;
  }

  async getPublicationBySlug(shareSlug: string) {
    const row = check(await this.client.from("see_publications").select("*").eq("share_slug", shareSlug).maybeSingle()) as Row | null;
    return row ? rowToPublication(row) : undefined;
  }

  async insertPublication(publication: SeePublication) {
    check(await this.client.from("see_publications").insert(publicationToRow(publication)));
  }

  async updatePublication(publication: SeePublication) {
    const { id, project_id: _projectId, ...changes } = publicationToRow(publication);
    check(await this.client.from("see_publications").update(changes).eq("id", id));
  }

  async insertGrant(grant: SeeAccessGrant) {
    check(await this.client.from("see_access_grants").insert({
      id: grant.id,
      publication_id: grant.publicationId,
      token_hash: grant.tokenHash,
      access_epoch: grant.accessEpoch,
      expires_at: grant.expiresAt,
      created_at: grant.createdAt,
    }));
  }

  async getGrantByTokenHash(tokenHash: string): Promise<SeeAccessGrant | undefined> {
    const row = check(await this.client.from("see_access_grants").select("*").eq("token_hash", tokenHash).maybeSingle()) as Row | null;
    return row ? {
      id: row.id as string,
      publicationId: row.publication_id as string,
      tokenHash: row.token_hash as string,
      accessEpoch: row.access_epoch as number,
      expiresAt: row.expires_at as string,
      revokedAt: optional(row.revoked_at as string | null),
      createdAt: row.created_at as string,
    } : undefined;
  }

  async revokeGrants(publicationId: string, revokedAt: string) {
    check(await this.client.from("see_access_grants").update({ revoked_at: revokedAt }).eq("publication_id", publicationId).is("revoked_at", null));
  }

  async countPinFailures(publicationId: string, sinceIso: string, clientHash?: string) {
    let request = this.client.from("see_pin_attempts").select("id", { count: "exact", head: true }).eq("publication_id", publicationId).gte("created_at", sinceIso);
    if (clientHash) request = request.eq("client_hash", clientHash);
    const result = await request;
    if (result.error) throw result.error;
    return result.count ?? 0;
  }

  async insertPinFailure(publicationId: string, clientHash: string, atIso: string) {
    check(await this.client.from("see_pin_attempts").insert({ publication_id: publicationId, client_hash: clientHash, created_at: atIso }));
  }

  async recordView(input: SeeViewInput) {
    const result = await this.client.rpc("see_record_view", {
      p_publication_id: input.publicationId,
      p_project_id: input.projectId,
      p_visitor_hash: input.visitorHash,
      p_embed: input.embed,
      p_dedupe_seconds: input.dedupeSeconds,
    });
    if (result.error) throw result.error;
    return result.data === true;
  }
}
