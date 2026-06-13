import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ARCHIVE_SESSION_ID_PATTERN,
  RequestStoreError,
  SUBMIT_LEASE_FILE_NAME,
  appendRequestContent,
  archiveRequest,
  beginRequestSubmit,
  completeRequestSubmit,
  createRequestFile,
  listRequests,
  readReasoningResource,
  readRequestResource,
  readResponseResource,
  requestVersions,
  resolveActiveRequestPair,
  sanitizeName,
  updateRequestContent,
  updateRequestMeta,
} from "../mcp/archive/archive.js";
import { readRequestCreationIndexIds, requestCreationIndexBackfillMarkerPath, requestCreationIndexFilePath } from "../mcp/archive/requestIndex.js";
import { appendRequestZip } from "../mcp/archive/zipAppend.js";
import { countTextTokens } from "../mcp/deepseek/tokenizer.js";
import { storedZipBuffer, writeStoredZip } from "./zipTestHelper.js";

test("request_create creates an empty draft version 0 under requests", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-mcp-"));
  const pair = await createRequestFile("Asking to describe file structure", dir);

  assert.match(pair.id, ARCHIVE_SESSION_ID_PATTERN);
  assert.equal(pair.archived, false);
  assert.equal(pair.version, 0);
  assert.equal(path.basename(pair.sessionDir), pair.id);
  assert.equal(path.basename(path.dirname(pair.sessionDir)), "requests");
  assert.equal(path.basename(pair.versionDir), "0");
  assert.equal(path.basename(path.dirname(pair.versionDir)), "versions");
  assert.equal(path.basename(pair.requestPath), "REQUEST.md");
  assert.equal(path.basename(pair.requestJsonPath), "request.json");
  assert.equal(path.basename(pair.metaPath), "meta.json");
  assert.equal(pair.safeName, "Asking to describe file structure");
  assert.equal(sanitizeName("  ../x  "), "-x");

  const resource = await readRequestResource(pair.id, dir);
  assert.equal(resource.content, "");
  assert.equal(resource.request.title, "Asking to describe file structure");
  assert.equal(resource.request.version, 0);
  assert.equal(resource.request.status, "draft");
  assert.equal(resource.request.archived, false);
  assert.deepEqual(Object.keys(resource.request.price).sort(), ["deepseek-v4-flash", "deepseek-v4-pro"]);
  assert.equal(resource.request.price["deepseek-v4-pro"]?.inputTokens, 0);
  assert.equal(resource.request.price["deepseek-v4-pro"]?.outputTokens, 0);

  const meta = JSON.parse(await fs.readFile(pair.metaPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(meta).sort(), ["created", "title", "updated"]);
  const indexPath = requestCreationIndexFilePath(dir, String(meta.created));
  assert.equal(await fs.readFile(indexPath, "utf8"), `${pair.id}\n`);

  const requestJson = JSON.parse(await fs.readFile(pair.requestJsonPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(requestJson).sort(), ["created", "status", "updated"]);
  assert.equal(requestJson.status, "draft");
});

test("request_create appends creation index entries concurrently", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-mcp-"));
  const pairs = await Promise.all(Array.from({ length: 24 }, (_, index) => createRequestFile(`Concurrent indexed request ${index}`, dir)));

  const ids = await readRequestCreationIndexIds(dir, { createdAfter: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() });

  assert.ok(ids);
  assert.equal(new Set(ids).size, ids.length);
  for (const pair of pairs) {
    assert.ok(ids.includes(pair.id), `${pair.id} was not written to the creation index`);
  }
});

test("listRequests filters recent requests by indexed creation time", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-mcp-"));
  const old = await createRequestFile("Old by creation", dir);
  const fresh = await createRequestFile("Fresh by creation", dir);
  const oldCreated = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  await updateRequestMeta(old, { created: oldCreated, updated: new Date().toISOString() });
  await fs.rm(path.join(dir, "index"), { recursive: true, force: true });

  const entries = await listRequests({ rootDir: dir, createdAfter: new Date(Date.now() - 60 * 60 * 1000).toISOString() });

  assert.deepEqual(
    entries.map((entry) => entry.id),
    [fresh.id],
  );
  assert.equal(await fs.readFile(requestCreationIndexBackfillMarkerPath(dir), "utf8").then((value) => value.length > 0), true);
});

test("request_update creates a new immutable draft version", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-mcp-"));
  const pair = await createRequestFile("Versioned request", dir);
  const beforeMeta = JSON.parse(await fs.readFile(pair.metaPath, "utf8")) as { created: string; title: string };

  const updated = await updateRequestContent(pair.id, "Explain versioning.", dir);

  assert.equal(updated.version, 1);
  assert.equal(updated.status, "draft");
  assert.equal(updated.price["deepseek-v4-pro"]?.inputTokens, countTextTokens("Explain versioning."));
  assert.equal((await readRequestResource(pair.id, dir, 0)).content, "");
  assert.equal((await readRequestResource(pair.id, dir, 1)).content, "Explain versioning.");

  const afterMeta = JSON.parse(await fs.readFile(pair.metaPath, "utf8")) as { created: string; title: string; updated: string };
  assert.equal(afterMeta.title, beforeMeta.title);
  assert.equal(afterMeta.created, beforeMeta.created);
  assert.notEqual(afterMeta.updated, undefined);

  const entries = await listRequests(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.version, 1);
  assert.equal(entries[0]?.status, "draft");
});

test("request_append adds text to the current draft version without creating a new version", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-mcp-"));
  const pair = await createRequestFile("Layered request", dir);
  await updateRequestContent(pair.id, "Prompt header\n", dir);

  const appended = await appendRequestContent(pair.id, "\nFile content\n", dir);
  await appendRequestContent(pair.id, "\nFinal instruction", dir);

  assert.equal(appended.version, 1);
  assert.equal(appended.createdVersion, false);
  assert.equal((await requestVersions(pair.id, dir)).length, 2);
  assert.equal((await readRequestResource(pair.id, dir, 1)).content, "Prompt header\n\nFile content\n\nFinal instruction");
});

test("request metadata cache is invalidated after same-id content changes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-mcp-"));
  const pair = await createRequestFile("Cached metadata", dir);

  const before = await readRequestResource(pair.id, dir);
  assert.equal(before.request.size, 0);
  assert.equal(before.request.lines, 0);

  await appendRequestContent(pair.id, "first\nsecond", dir);
  const after = await readRequestResource(pair.id, dir);
  const versions = await requestVersions(pair.id, dir);

  assert.equal(after.request.size, Buffer.byteLength("first\nsecond", "utf8"));
  assert.equal(after.request.lines, 2);
  assert.equal(after.content, "first\nsecond");
  assert.equal(versions.at(-1)?.requestLines, 2);
});

test("request_archive moves the whole request tree and active list excludes it", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-mcp-"));
  const pair = await createRequestFile("Archive me", dir);
  await updateRequestContent(pair.id, "Keep this content.", dir);

  const archived = await archiveRequest(pair.id, dir);

  assert.equal(archived.archived, true);
  assert.equal((await listRequests({ rootDir: dir, scope: "active" })).length, 0);
  const archivedEntries = await listRequests({ rootDir: dir, scope: "archived" });
  assert.equal(archivedEntries.length, 1);
  assert.equal(archivedEntries[0]?.id, pair.id);
  assert.equal((await readRequestResource(pair.id, dir)).request.archived, true);
  assert.equal((await readRequestResource(pair.id, dir)).content, "Keep this content.");
});

test("archived requests and filling requests cannot be updated", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-mcp-"));
  const pair = await createRequestFile("No mutation", dir);
  await archiveRequest(pair.id, dir);

  await assert.rejects(() => updateRequestContent(pair.id, "new content", dir), (error: unknown) => {
    assert.ok(error instanceof RequestStoreError);
    assert.equal(error.statusCode, 409);
    return true;
  });
});

test("request_append creates a new draft version when the current version is already filled", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-mcp-"));
  const pair = await createRequestFile("Filled request", dir);
  await updateRequestContent(pair.id, "ready", dir);
  const current = await resolveActiveRequestPair(pair.id, dir);
  await beginRequestSubmit(current, {
    source: "mcp-archived-request",
    requestedOptions: { model: "deepseek-v4-pro" },
    effectiveApiParameters: { model: "deepseek-v4-pro" },
  });
  await completeRequestSubmit(current);

  const appended = await appendRequestContent(pair.id, "next layer", dir);

  assert.equal(appended.createdVersion, true);
  assert.equal(appended.version, 2);
  assert.equal(appended.request.status, "draft");
  assert.equal((await readRequestResource(pair.id, dir, 2)).content, "next layer");
});

test("request_append rejects pending current versions", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-mcp-"));
  const pair = await createRequestFile("Pending request", dir);
  await updateRequestContent(pair.id, "ready", dir);
  const current = await resolveActiveRequestPair(pair.id, dir);
  await beginRequestSubmit(current, {
    source: "mcp-archived-request",
    requestedOptions: { model: "deepseek-v4-pro" },
    effectiveApiParameters: { model: "deepseek-v4-pro" },
  });

  await assert.rejects(() => appendRequestContent(pair.id, "too soon", dir), (error: unknown) => {
    assert.ok(error instanceof RequestStoreError);
    assert.equal(error.statusCode, 409);
    assert.match(error.message, /still answering/);
    return true;
  });
});

test("stale running request versions become errors when their submit lease is gone", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-mcp-"));
  const oldStaleMs = process.env.DEEPSEEK_SUBMIT_LEASE_STALE_MS;
  process.env.DEEPSEEK_SUBMIT_LEASE_STALE_MS = "0";
  const pair = await createRequestFile("Interrupted submit", dir);
  await updateRequestContent(pair.id, "ready", dir);
  const current = await resolveActiveRequestPair(pair.id, dir);
  await beginRequestSubmit(current, {
    source: "mcp-archived-request",
    requestedOptions: { model: "deepseek-v4-pro" },
    effectiveApiParameters: { model: "deepseek-v4-pro" },
  });
  await fs.rm(path.join(current.versionDir, SUBMIT_LEASE_FILE_NAME), { force: true });

  try {
    const request = await readRequestResource(pair.id, dir);
    const response = await readResponseResource(pair.id, dir);
    const reasoning = await readReasoningResource(pair.id, dir);

    assert.equal(request.request.status, "error");
    assert.equal(request.request.version, current.version);
    assert.equal(response.response.status, "error");
    assert.equal(reasoning.reasoning.status, "error");
    assert.match(response.response.error ?? "", /interrupted/i);
  } finally {
    if (oldStaleMs === undefined) delete process.env.DEEPSEEK_SUBMIT_LEASE_STALE_MS;
    else process.env.DEEPSEEK_SUBMIT_LEASE_STALE_MS = oldStaleMs;
  }
});

test("request_append_zip appends sorted UTF-8 file blocks to the current draft version", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-mcp-"));
  const pair = await createRequestFile("Project files", dir);
  await updateRequestContent(pair.id, "Review these files:\n\n", dir);
  const zipPath = path.join(dir, "project.zip");
  await writeStoredZip(zipPath, [
    { path: "mcp/z.ts", content: "export const z = 1;" },
    { path: "package.json", content: "{\"type\":\"module\"}\n" },
    { path: "mcp/a.ts", content: "export const a = 1;" },
  ]);

  const result = await appendRequestZip(pair.id, { zipPath }, dir);

  assert.equal(result.version, 1);
  assert.deepEqual(
    result.files.map((file) => file.path),
    ["mcp/a.ts", "mcp/z.ts", "package.json"],
  );
  assert.equal(result.skippedFiles.length, 0);
  assert.equal(
    (await readRequestResource(pair.id, dir, 1)).content,
    'Review these files:\n\nmcp/a.ts\n\nexport const a = 1;\n\nmcp/z.ts\n\nexport const z = 1;\n\npackage.json\n\n{"type":"module"}\n',
  );
});

test("request_append_zip rejects binary files by default and can skip them", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-mcp-"));
  const pair = await createRequestFile("Mixed zip", dir);
  const zipPath = path.join(dir, "mixed.zip");
  await writeStoredZip(zipPath, [
    { path: "mcp/main.ts", content: "console.log('ok');" },
    { path: "assets/blob.bin", content: Buffer.from([0, 1, 2, 3]) },
  ]);

  await assert.rejects(() => appendRequestZip(pair.id, { zipPath }, dir), (error: unknown) => {
    assert.ok(error instanceof RequestStoreError);
    assert.equal(error.statusCode, 400);
    assert.match(error.message, /looks binary/);
    return true;
  });

  const result = await appendRequestZip(pair.id, { zipPath, binaryPolicy: "skip" }, dir);

  assert.deepEqual(result.files.map((file) => file.path), ["mcp/main.ts"]);
  assert.deepEqual(result.skippedFiles.map((file) => file.path), ["assets/blob.bin"]);
  assert.equal((await readRequestResource(pair.id, dir, 0)).content, "mcp/main.ts\n\nconsole.log('ok');");
});

test("request_append_zip accepts deflated inline base64 ZIP bytes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-mcp-"));
  const pair = await createRequestFile("Inline zip", dir);
  const zipBase64 = storedZipBuffer([{ path: "mcp/inline.ts", content: "export const inline = true;", compression: "deflate" }]).toString("base64");

  const result = await appendRequestZip(pair.id, { zipBase64 }, dir);

  assert.equal(result.version, 0);
  assert.deepEqual(result.files.map((file) => file.path), ["mcp/inline.ts"]);
  assert.equal((await readRequestResource(pair.id, dir, 0)).content, "mcp/inline.ts\n\nexport const inline = true;");
});

test("response resource returns a clear 404 before submit creates response files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-mcp-"));
  const pair = await createRequestFile("No response yet", dir);

  await assert.rejects(() => readResponseResource(pair.id, dir), (error: unknown) => {
    assert.ok(error instanceof RequestStoreError);
    assert.equal(error.statusCode, 404);
    assert.match(error.message, /has not been submitted/);
    return true;
  });
});

test("request_versions reports request version metadata", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deepseek-mcp-"));
  const pair = await createRequestFile("Version report", dir);
  await updateRequestContent(pair.id, "v1", dir);

  const versions = await requestVersions(pair.id, dir);

  assert.deepEqual(
    versions.map((version) => ({
      version: version.version,
      isCurrent: version.isCurrent,
      requestStatus: version.requestStatus,
      requestSize: version.requestSize,
    })),
    [
      { version: 0, isCurrent: false, requestStatus: "draft", requestSize: 0 },
      { version: 1, isCurrent: true, requestStatus: "draft", requestSize: 2 },
    ],
  );

  const current = await resolveActiveRequestPair(pair.id, dir);
  assert.equal(current.version, 1);
});
