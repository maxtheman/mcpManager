// ============================================================================
// Playwright Session Manager - HelixQL Queries
// ============================================================================
//
// This file contains all HelixQL queries for the Playwright Session Manager.
// Queries are organized by category and correspond to the schema in schema.hx.
//
// Query Categories:
//   1. Pool CRUD - Create/read/update pool records
//   2. Session CRUD - Session lifecycle management
//   3. Context CRUD - BrowserContext operations
//   4. Tab CRUD - Tab/Page operations
//   5. Command Audit - Tool call history tracking
//   6. Introspection - List and query operations
//   7. Janitor - Cleanup and expiration queries
//
// ============================================================================


// ============================================================================
// 1. POOL CRUD
// ============================================================================

QUERY CreatePool(pool_key: String, kind: String, now_ms: U64) =>
  pool <- AddN<Pool>({
    pool_key: pool_key,
    kind: kind,
    created_at_ms: now_ms,
    last_heartbeat_at_ms: now_ms,
  })
  RETURN pool::{ pool_key: _::{pool_key}, kind: _::{kind} }

QUERY GetPoolByKey(pool_key: String) =>
  pool <- N<Pool>({pool_key: pool_key})
  RETURN pool::{ pool_key: _::{pool_key}, kind: _::{kind}, last_heartbeat_at_ms: _::{last_heartbeat_at_ms} }

QUERY GetPool(pool_id: ID) =>
  pool <- N<Pool>(pool_id)
  RETURN pool::{ pool_key: _::{pool_key}, kind: _::{kind}, last_heartbeat_at_ms: _::{last_heartbeat_at_ms} }

QUERY UpdatePoolHeartbeat(pool_id: ID, now_ms: U64) =>
  pool <- N<Pool>(pool_id)
  updated <- pool::UPDATE({last_heartbeat_at_ms: now_ms})
  RETURN updated::{ last_heartbeat_at_ms: _::{last_heartbeat_at_ms} }

QUERY DeletePool(pool_id: ID) =>
  DROP N<Pool>(pool_id)
  RETURN "deleted"


// ============================================================================
// 2. SESSION CRUD
// ============================================================================

QUERY CreateSession(
  pool_id: ID,
  pool_key: String,
  session_key: String,
  owner_agent: String,
  ttl_seconds: U32,
  expires_at_ms: U64,
  now_ms: U64,
  metadata_json: String
) =>
  session <- AddN<Session>({
    session_key: session_key,
    pool_key: pool_key,
    owner_agent: owner_agent,
    status: "starting",
    created_at_ms: now_ms,
    updated_at_ms: now_ms,
    ttl_seconds: ttl_seconds,
    expires_at_ms: expires_at_ms,
    active_tab_id: "",
    metadata_json: metadata_json,
    last_error: "",
  })
  link <- AddE<PoolHasSession>({created_at_ms: now_ms})::From(pool_id)::To(session)
  RETURN session::{ session_key: _::{session_key}, status: _::{status}, expires_at_ms: _::{expires_at_ms} }

QUERY GetSession(session_id: ID) =>
  s <- N<Session>(session_id)
  RETURN s::{
    session_key: _::{session_key},
    pool_key: _::{pool_key},
    owner_agent: _::{owner_agent},
    status: _::{status},
    created_at_ms: _::{created_at_ms},
    updated_at_ms: _::{updated_at_ms},
    ttl_seconds: _::{ttl_seconds},
    expires_at_ms: _::{expires_at_ms},
    active_tab_id: _::{active_tab_id},
    metadata_json: _::{metadata_json},
    last_error: _::{last_error},
  }

QUERY GetSessionByKey(session_key: String) =>
  s <- N<Session>({session_key: session_key})
  RETURN s::{
    session_key: _::{session_key},
    pool_key: _::{pool_key},
    owner_agent: _::{owner_agent},
    status: _::{status},
    expires_at_ms: _::{expires_at_ms},
    active_tab_id: _::{active_tab_id},
  }

QUERY UpdateSessionStatus(session_id: ID, status: String, now_ms: U64) =>
  s <- N<Session>(session_id)
  updated <- s::UPDATE({status: status, updated_at_ms: now_ms})
  RETURN updated::{ status: _::{status}, updated_at_ms: _::{updated_at_ms} }

QUERY UpdateSessionActiveTab(session_id: ID, tab_id: String, now_ms: U64) =>
  s <- N<Session>(session_id)
  updated <- s::UPDATE({active_tab_id: tab_id, updated_at_ms: now_ms})
  RETURN updated::{ active_tab_id: _::{active_tab_id} }

QUERY UpdateSessionError(session_id: ID, error: String, status: String, now_ms: U64) =>
  s <- N<Session>(session_id)
  updated <- s::UPDATE({last_error: error, status: status, updated_at_ms: now_ms})
  RETURN updated::{ status: _::{status}, last_error: _::{last_error} }

QUERY ExtendSessionTTL(session_id: ID, new_expires_at_ms: U64, now_ms: U64) =>
  s <- N<Session>(session_id)
  updated <- s::UPDATE({expires_at_ms: new_expires_at_ms, updated_at_ms: now_ms})
  RETURN updated::{ expires_at_ms: _::{expires_at_ms} }

QUERY EndSession(session_id: ID, status: String, now_ms: U64) =>
  s <- N<Session>(session_id)
  updated <- s::UPDATE({status: status, updated_at_ms: now_ms})
  RETURN updated::{ status: _::{status} }

QUERY DeleteSession(session_id: ID) =>
  DROP N<Session>(session_id)
  RETURN "deleted"


// ============================================================================
// 3. CONTEXT CRUD
// ============================================================================

QUERY CreateContext(
  session_id: ID,
  context_key: String,
  now_ms: U64,
  browser_type: String,
  options_json: String
) =>
  ctx <- AddN<Context>({
    context_key: context_key,
    status: "open",
    created_at_ms: now_ms,
    closed_at_ms: 0,
    browser_type: browser_type,
    options_json: options_json,
  })
  link <- AddE<SessionHasContext>({created_at_ms: now_ms})::From(session_id)::To(ctx)
  RETURN ctx::{ context_key: _::{context_key}, status: _::{status} }

QUERY GetContext(context_id: ID) =>
  ctx <- N<Context>(context_id)
  RETURN ctx::{
    context_key: _::{context_key},
    status: _::{status},
    created_at_ms: _::{created_at_ms},
    closed_at_ms: _::{closed_at_ms},
    browser_type: _::{browser_type},
    options_json: _::{options_json},
  }

QUERY GetContextByKey(context_key: String) =>
  ctx <- N<Context>({context_key: context_key})
  RETURN ctx::{ context_key: _::{context_key}, status: _::{status} }

QUERY GetSessionContext(session_id: ID) =>
  ctx <- N<Session>(session_id)::Out<SessionHasContext>
  RETURN ctx::{
    context_key: _::{context_key},
    status: _::{status},
    browser_type: _::{browser_type},
  }

QUERY CloseContext(context_id: ID, status: String, now_ms: U64) =>
  ctx <- N<Context>(context_id)
  updated <- ctx::UPDATE({status: status, closed_at_ms: now_ms})
  RETURN updated::{ status: _::{status}, closed_at_ms: _::{closed_at_ms} }

QUERY MarkContextOrphaned(context_id: ID, status: String, now_ms: U64) =>
  ctx <- N<Context>(context_id)
  updated <- ctx::UPDATE({status: status, closed_at_ms: now_ms})
  RETURN updated::{ status: _::{status} }

QUERY DeleteContext(context_id: ID) =>
  DROP N<Context>(context_id)
  RETURN "deleted"


// ============================================================================
// 4. TAB CRUD
// ============================================================================

QUERY AddTab(
  context_id: ID,
  tab_key: String,
  opener_tab_id: String,
  is_popup: Boolean,
  now_ms: U64,
  tab_index: U32,
  url: String,
  title: String
) =>
  tab <- AddN<Tab>({
    tab_key: tab_key,
    status: "open",
    created_at_ms: now_ms,
    closed_at_ms: 0,
    last_seen_at_ms: now_ms,
    url: url,
    title: title,
    opener_tab_id: opener_tab_id,
    is_popup: is_popup,
  })
  link <- AddE<ContextHasTab>({created_at_ms: now_ms, tab_index: tab_index})::From(context_id)::To(tab)
  RETURN tab::{ tab_key: _::{tab_key}, status: _::{status} }

QUERY GetTab(tab_id: ID) =>
  t <- N<Tab>(tab_id)
  RETURN t::{
    tab_key: _::{tab_key},
    status: _::{status},
    created_at_ms: _::{created_at_ms},
    closed_at_ms: _::{closed_at_ms},
    last_seen_at_ms: _::{last_seen_at_ms},
    url: _::{url},
    title: _::{title},
    opener_tab_id: _::{opener_tab_id},
    is_popup: _::{is_popup},
  }

QUERY GetTabByKey(tab_key: String) =>
  t <- N<Tab>({tab_key: tab_key})
  RETURN t::{ tab_key: _::{tab_key}, status: _::{status}, url: _::{url} }

QUERY UpdateTabUrl(tab_id: ID, url: String, title: String, now_ms: U64) =>
  t <- N<Tab>(tab_id)
  updated <- t::UPDATE({url: url, title: title, last_seen_at_ms: now_ms})
  RETURN updated::{ url: _::{url}, title: _::{title} }

QUERY UpdateTabLastSeen(tab_id: ID, now_ms: U64) =>
  t <- N<Tab>(tab_id)
  updated <- t::UPDATE({last_seen_at_ms: now_ms})
  RETURN updated::{ last_seen_at_ms: _::{last_seen_at_ms} }

QUERY CloseTab(tab_id: ID, status: String, now_ms: U64) =>
  t <- N<Tab>(tab_id)
  updated <- t::UPDATE({status: status, closed_at_ms: now_ms})
  RETURN updated::{ status: _::{status}, closed_at_ms: _::{closed_at_ms} }

QUERY DeleteTab(tab_id: ID) =>
  DROP N<Tab>(tab_id)
  RETURN "deleted"


// ============================================================================
// 5. COMMAND AUDIT
// ============================================================================

QUERY RecordCommand(
  session_id: ID,
  tab_id: ID,
  seq: U64,
  tool: String,
  args_json: String,
  ok: Boolean,
  started_at_ms: U64,
  duration_ms: U32,
  error: String
) =>
  cmd <- AddE<SessionCommand>({
    seq: seq,
    tool: tool,
    args_json: args_json,
    ok: ok,
    started_at_ms: started_at_ms,
    duration_ms: duration_ms,
    error: error,
  })::From(session_id)::To(tab_id)
  RETURN cmd::{ seq: _::{seq}, tool: _::{tool}, ok: _::{ok} }

QUERY GetSessionCommands(session_id: ID) =>
  cmds <- N<Session>(session_id)::OutE<SessionCommand>
  RETURN cmds::{
    seq: _::{seq},
    tool: _::{tool},
    args_json: _::{args_json},
    ok: _::{ok},
    started_at_ms: _::{started_at_ms},
    duration_ms: _::{duration_ms},
    error: _::{error},
  }

QUERY GetTabCommands(tab_id: ID) =>
  cmds <- N<Tab>(tab_id)::InE<SessionCommand>
  RETURN cmds::{
    seq: _::{seq},
    tool: _::{tool},
    ok: _::{ok},
    started_at_ms: _::{started_at_ms},
    duration_ms: _::{duration_ms},
    error: _::{error},
  }

QUERY GetFailedCommands(session_id: ID) =>
  cmds <- N<Session>(session_id)::OutE<SessionCommand>::WHERE(_::{ok}::EQ(false))
  RETURN cmds::{
    seq: _::{seq},
    tool: _::{tool},
    error: _::{error},
    started_at_ms: _::{started_at_ms},
  }


// ============================================================================
// 6. INTROSPECTION QUERIES
// ============================================================================

QUERY ListPools() =>
  pools <- N<Pool>
  RETURN pools::{ pool_key: _::{pool_key}, kind: _::{kind}, last_heartbeat_at_ms: _::{last_heartbeat_at_ms} }

QUERY ListPoolSessions(pool_id: ID) =>
  sessions <- N<Pool>(pool_id)::Out<PoolHasSession>
  RETURN sessions::{
    session_key: _::{session_key},
    owner_agent: _::{owner_agent},
    status: _::{status},
    expires_at_ms: _::{expires_at_ms},
  }

QUERY ListSessionsByOwner(owner_agent: String) =>
  sessions <- N<Session>::WHERE(_::{owner_agent}::EQ(owner_agent))
  RETURN sessions::{
    session_key: _::{session_key},
    status: _::{status},
    pool_key: _::{pool_key},
    expires_at_ms: _::{expires_at_ms},
  }

QUERY ListSessionsByStatus(status: String) =>
  sessions <- N<Session>::WHERE(_::{status}::EQ(status))
  RETURN sessions::{
    session_key: _::{session_key},
    owner_agent: _::{owner_agent},
    expires_at_ms: _::{expires_at_ms},
  }

QUERY ListSessionTabs(session_id: ID) =>
  ctx <- N<Session>(session_id)::Out<SessionHasContext>
  tabs <- ctx::Out<ContextHasTab>
  RETURN tabs::{
    tab_key: _::{tab_key},
    status: _::{status},
    url: _::{url},
    title: _::{title},
    is_popup: _::{is_popup},
  }

QUERY ListContextTabs(context_id: ID) =>
  tabs <- N<Context>(context_id)::Out<ContextHasTab>
  RETURN tabs::{
    tab_key: _::{tab_key},
    status: _::{status},
    url: _::{url},
    title: _::{title},
  }

QUERY ListOpenTabs(context_id: ID) =>
  tabs <- N<Context>(context_id)::Out<ContextHasTab>::WHERE(_::{status}::EQ("open"))
  RETURN tabs::{
    tab_key: _::{tab_key},
    url: _::{url},
    title: _::{title},
  }

QUERY CountPoolSessions(pool_id: ID) =>
  sessions <- N<Pool>(pool_id)::Out<PoolHasSession>
  RETURN sessions::COUNT

QUERY CountActiveSessions(pool_id: ID) =>
  sessions <- N<Pool>(pool_id)::Out<PoolHasSession>::WHERE(_::{status}::EQ("active"))
  RETURN sessions::COUNT


// ============================================================================
// 7. JANITOR QUERIES
// ============================================================================

QUERY ListExpiredSessions(now_ms: U64) =>
  expired <- N<Session>::WHERE(_::{status}::NEQ("ended"))
                        ::WHERE(_::{status}::NEQ("failed"))
                        ::WHERE(_::{expires_at_ms}::LT(now_ms))
  RETURN expired::{
    session_key: _::{session_key},
    status: _::{status},
    expires_at_ms: _::{expires_at_ms},
    pool_key: _::{pool_key},
  }

QUERY ListOrphanedContexts() =>
  orphaned <- N<Context>::WHERE(_::{status}::EQ("orphaned"))
  RETURN orphaned::{ context_key: _::{context_key} }

QUERY ListStalePools(cutoff_ms: U64) =>
  stale <- N<Pool>::WHERE(_::{last_heartbeat_at_ms}::LT(cutoff_ms))
  RETURN stale::{ pool_key: _::{pool_key}, last_heartbeat_at_ms: _::{last_heartbeat_at_ms} }

QUERY ListEndedSessions(cutoff_ms: U64) =>
  ended <- N<Session>::WHERE(_::{status}::EQ("ended"))
                      ::WHERE(_::{updated_at_ms}::LT(cutoff_ms))
  RETURN ended::{ session_key: _::{session_key}, updated_at_ms: _::{updated_at_ms} }

QUERY ListFailedSessions(cutoff_ms: U64) =>
  failed <- N<Session>::WHERE(_::{status}::EQ("failed"))
                       ::WHERE(_::{updated_at_ms}::LT(cutoff_ms))
  RETURN failed::{ session_key: _::{session_key}, last_error: _::{last_error} }

QUERY ListClosedTabs(cutoff_ms: U64) =>
  closed <- N<Tab>::WHERE(_::{status}::EQ("closed"))
                  ::WHERE(_::{closed_at_ms}::LT(cutoff_ms))
  RETURN closed::{ tab_key: _::{tab_key} }


// ############################################################################
// PART 2: ADO (Agentic Development Orchestrator) Queries
// ############################################################################


// ============================================================================
// 8. REPO CRUD
// ============================================================================

QUERY CreateRepo(repo_name: String, root_path: String, config_json: String, now_ms: U64) =>
  repo <- AddN<Repo>({
    repo_name: repo_name,
    root_path: root_path,
    created_at_ms: now_ms,
    updated_at_ms: now_ms,
    config_json: config_json,
    head_snapshot_id: "",
  })
  RETURN repo::{ repo_name: _::{repo_name}, root_path: _::{root_path} }

QUERY GetRepoByName(repo_name: String) =>
  repo <- N<Repo>({repo_name: repo_name})
  RETURN repo::{
    repo_name: _::{repo_name},
    root_path: _::{root_path},
    created_at_ms: _::{created_at_ms},
    updated_at_ms: _::{updated_at_ms},
    config_json: _::{config_json},
    head_snapshot_id: _::{head_snapshot_id},
  }

QUERY GetRepo(repo_id: ID) =>
  repo <- N<Repo>(repo_id)
  RETURN repo::{
    repo_name: _::{repo_name},
    root_path: _::{root_path},
    head_snapshot_id: _::{head_snapshot_id},
  }

QUERY UpdateRepoHead(repo_id: ID, head_snapshot_id: String, now_ms: U64) =>
  repo <- N<Repo>(repo_id)
  updated <- repo::UPDATE({head_snapshot_id: head_snapshot_id, updated_at_ms: now_ms})
  RETURN updated::{ head_snapshot_id: _::{head_snapshot_id} }

QUERY UpdateRepoConfig(repo_id: ID, config_json: String, now_ms: U64) =>
  repo <- N<Repo>(repo_id)
  updated <- repo::UPDATE({config_json: config_json, updated_at_ms: now_ms})
  RETURN updated::{ updated_at_ms: _::{updated_at_ms} }

QUERY ListRepos() =>
  repos <- N<Repo>
  RETURN repos::{ repo_name: _::{repo_name}, root_path: _::{root_path}, head_snapshot_id: _::{head_snapshot_id} }

QUERY DeleteRepo(repo_id: ID) =>
  DROP N<Repo>(repo_id)
  RETURN "deleted"


// ============================================================================
// 9. SNAPSHOT CRUD
// ============================================================================

QUERY CreateSnapshot(
  repo_id: ID,
  snapshot_key: String,
  repo_name: String,
  parent_snapshot_id: String,
  commit_sha: String,
  now_ms: U64,
  metadata_json: String
) =>
  snapshot <- AddN<Snapshot>({
    snapshot_key: snapshot_key,
    repo_name: repo_name,
    parent_snapshot_id: parent_snapshot_id,
    created_at_ms: now_ms,
    file_count: 0,
    total_bytes: 0,
    commit_sha: commit_sha,
    status: "pending",
    metadata_json: metadata_json,
  })
  link <- AddE<RepoHasSnapshot>({created_at_ms: now_ms, is_head: false})::From(repo_id)::To(snapshot)
  RETURN snapshot::{ snapshot_key: _::{snapshot_key}, status: _::{status} }

QUERY GetSnapshot(snapshot_id: ID) =>
  s <- N<Snapshot>(snapshot_id)
  RETURN s::{
    snapshot_key: _::{snapshot_key},
    repo_name: _::{repo_name},
    parent_snapshot_id: _::{parent_snapshot_id},
    created_at_ms: _::{created_at_ms},
    file_count: _::{file_count},
    total_bytes: _::{total_bytes},
    commit_sha: _::{commit_sha},
    status: _::{status},
    metadata_json: _::{metadata_json},
  }

QUERY GetSnapshotByKey(snapshot_key: String) =>
  s <- N<Snapshot>({snapshot_key: snapshot_key})
  RETURN s::{
    snapshot_key: _::{snapshot_key},
    repo_name: _::{repo_name},
    parent_snapshot_id: _::{parent_snapshot_id},
    created_at_ms: _::{created_at_ms},
    file_count: _::{file_count},
    total_bytes: _::{total_bytes},
    commit_sha: _::{commit_sha},
    status: _::{status},
    metadata_json: _::{metadata_json},
  }

QUERY UpdateSnapshotStatus(snapshot_id: ID, status: String, file_count: U32, total_bytes: U64) =>
  s <- N<Snapshot>(snapshot_id)
  updated <- s::UPDATE({status: status, file_count: file_count, total_bytes: total_bytes})
  RETURN updated::{ status: _::{status}, file_count: _::{file_count} }

QUERY ListRepoSnapshots(repo_id: ID) =>
  snapshots <- N<Repo>(repo_id)::Out<RepoHasSnapshot>
  RETURN snapshots::{
    snapshot_key: _::{snapshot_key},
    status: _::{status},
    created_at_ms: _::{created_at_ms},
    file_count: _::{file_count},
    commit_sha: _::{commit_sha},
  }

QUERY DeleteSnapshot(snapshot_id: ID) =>
  DROP N<Snapshot>(snapshot_id)
  RETURN "deleted"


// ============================================================================
// 10. FILE CRUD
// ============================================================================

QUERY CreateFile(
  snapshot_id: ID,
  file_key: String,
  path: String,
  content: String,
  sha256: String,
  language: String,
  size_bytes: U64,
  line_count: U32,
  now_ms: U64
) =>
  file <- AddN<File>({
    file_key: file_key,
    path: path,
    content: content,
    sha256: sha256,
    language: language,
    size_bytes: size_bytes,
    line_count: line_count,
    created_at_ms: now_ms,
  })
  link <- AddE<SnapshotHasFile>({created_at_ms: now_ms})::From(snapshot_id)::To(file)
  RETURN file::{ file_key: _::{file_key}, path: _::{path}, sha256: _::{sha256} }

QUERY GetFile(file_id: ID) =>
  f <- N<File>(file_id)
  RETURN f::{
    file_key: _::{file_key},
    path: _::{path},
    content: _::{content},
    sha256: _::{sha256},
    language: _::{language},
    size_bytes: _::{size_bytes},
    line_count: _::{line_count},
  }

QUERY GetFileByKey(file_key: String) =>
  f <- N<File>({file_key: file_key})
  RETURN f::{
    file_key: _::{file_key},
    path: _::{path},
    sha256: _::{sha256},
    language: _::{language},
  }

QUERY GetSnapshotFiles(snapshot_id: ID) =>
  files <- N<Snapshot>(snapshot_id)::Out<SnapshotHasFile>
  RETURN files::{
    file_key: _::{file_key},
    path: _::{path},
    sha256: _::{sha256},
    language: _::{language},
    size_bytes: _::{size_bytes},
  }

QUERY GetFileContent(file_id: ID) =>
  f <- N<File>(file_id)
  RETURN f::{ path: _::{path}, content: _::{content} }

QUERY DeleteFile(file_id: ID) =>
  DROP N<File>(file_id)
  RETURN "deleted"


// ============================================================================
// 11. PROPOSAL CRUD
// ============================================================================

QUERY CreateProposal(
  repo_id: ID,
  proposal_key: String,
  repo_name: String,
  base_snapshot_id: String,
  created_by: String,
  title: String,
  description: String,
  now_ms: U64,
  metadata_json: String
) =>
  proposal <- AddN<Proposal>({
    proposal_key: proposal_key,
    repo_name: repo_name,
    base_snapshot_id: base_snapshot_id,
    status: "draft",
    created_at_ms: now_ms,
    updated_at_ms: now_ms,
    created_by: created_by,
    title: title,
    description: description,
    edit_count: 0,
    metadata_json: metadata_json,
  })
  link <- AddE<RepoHasProposal>({created_at_ms: now_ms})::From(repo_id)::To(proposal)
  RETURN proposal::{ proposal_key: _::{proposal_key}, status: _::{status} }

QUERY GetProposal(proposal_id: ID) =>
  p <- N<Proposal>(proposal_id)
  RETURN p::{
    proposal_key: _::{proposal_key},
    repo_name: _::{repo_name},
    base_snapshot_id: _::{base_snapshot_id},
    status: _::{status},
    created_at_ms: _::{created_at_ms},
    updated_at_ms: _::{updated_at_ms},
    created_by: _::{created_by},
    title: _::{title},
    description: _::{description},
    edit_count: _::{edit_count},
    metadata_json: _::{metadata_json},
  }

QUERY GetProposalByKey(proposal_key: String) =>
  p <- N<Proposal>({proposal_key: proposal_key})
  RETURN p::{
    proposal_key: _::{proposal_key},
    repo_name: _::{repo_name},
    base_snapshot_id: _::{base_snapshot_id},
    status: _::{status},
    created_at_ms: _::{created_at_ms},
    updated_at_ms: _::{updated_at_ms},
    created_by: _::{created_by},
    title: _::{title},
    description: _::{description},
    edit_count: _::{edit_count},
    metadata_json: _::{metadata_json},
  }

QUERY UpdateProposalStatus(proposal_id: ID, status: String, now_ms: U64) =>
  p <- N<Proposal>(proposal_id)
  updated <- p::UPDATE({status: status, updated_at_ms: now_ms})
  RETURN updated::{ status: _::{status} }

QUERY UpdateProposalEditCount(proposal_id: ID, edit_count: U32, now_ms: U64) =>
  p <- N<Proposal>(proposal_id)
  updated <- p::UPDATE({edit_count: edit_count, updated_at_ms: now_ms})
  RETURN updated::{ edit_count: _::{edit_count} }

QUERY ListRepoProposals(repo_id: ID) =>
  proposals <- N<Repo>(repo_id)::Out<RepoHasProposal>
  RETURN proposals::{
    proposal_key: _::{proposal_key},
    status: _::{status},
    title: _::{title},
    created_by: _::{created_by},
    created_at_ms: _::{created_at_ms},
    edit_count: _::{edit_count},
  }

QUERY ListProposalsByStatus(status: String) =>
  proposals <- N<Proposal>::WHERE(_::{status}::EQ(status))
  RETURN proposals::{
    proposal_key: _::{proposal_key},
    repo_name: _::{repo_name},
    title: _::{title},
    created_at_ms: _::{created_at_ms},
  }

QUERY DeleteProposal(proposal_id: ID) =>
  DROP N<Proposal>(proposal_id)
  RETURN "deleted"


// ============================================================================
// 12. FILE EDIT CRUD
// ============================================================================

QUERY CreateFileEdit(
  proposal_id: ID,
  edit_key: String,
  path: String,
  kind: String,
  content: String,
  sha256: String,
  old_path: String,
  now_ms: U64,
  seq: U32
) =>
  edit <- AddN<FileEdit>({
    edit_key: edit_key,
    path: path,
    kind: kind,
    content: content,
    sha256: sha256,
    old_path: old_path,
    created_at_ms: now_ms,
  })
  link <- AddE<ProposalHasEdit>({created_at_ms: now_ms, seq: seq})::From(proposal_id)::To(edit)
  RETURN edit::{ edit_key: _::{edit_key}, path: _::{path}, kind: _::{kind} }

QUERY GetFileEdit(edit_id: ID) =>
  e <- N<FileEdit>(edit_id)
  RETURN e::{
    edit_key: _::{edit_key},
    path: _::{path},
    kind: _::{kind},
    content: _::{content},
    sha256: _::{sha256},
    old_path: _::{old_path},
    created_at_ms: _::{created_at_ms},
  }

QUERY GetProposalEdits(proposal_id: ID) =>
  edits <- N<Proposal>(proposal_id)::Out<ProposalHasEdit>
  RETURN edits::{
    edit_key: _::{edit_key},
    path: _::{path},
    kind: _::{kind},
    sha256: _::{sha256},
  }

QUERY DeleteFileEdit(edit_id: ID) =>
  DROP N<FileEdit>(edit_id)
  RETURN "deleted"


// ============================================================================
// 13. VALIDATION RUN CRUD
// ============================================================================

QUERY CreateValidationRun(
  target_id: ID,
  target_type: String,
  validation_key: String,
  tool_versions_json: String,
  now_ms: U64
) =>
  run <- AddN<ValidationRun>({
    validation_key: validation_key,
    target_type: target_type,
    status: "running",
    created_at_ms: now_ms,
    completed_at_ms: 0,
    tool_versions_json: tool_versions_json,
    error_count: 0,
    warning_count: 0,
    metrics_json: "{}",
  })
  RETURN run::{ validation_key: _::{validation_key}, status: _::{status} }

QUERY LinkValidationToSnapshot(snapshot_id: ID, validation_id: ID, now_ms: U64) =>
  link <- AddE<HasValidation>({created_at_ms: now_ms})::From(snapshot_id)::To(validation_id)
  RETURN link::{ created_at_ms: _::{created_at_ms} }

QUERY LinkValidationToProposal(proposal_id: ID, validation_id: ID, now_ms: U64) =>
  link <- AddE<ProposalHasValidation>({created_at_ms: now_ms})::From(proposal_id)::To(validation_id)
  RETURN link::{ created_at_ms: _::{created_at_ms} }

QUERY GetValidationRun(validation_id: ID) =>
  v <- N<ValidationRun>(validation_id)
  RETURN v::{
    validation_key: _::{validation_key},
    target_type: _::{target_type},
    status: _::{status},
    created_at_ms: _::{created_at_ms},
    completed_at_ms: _::{completed_at_ms},
    tool_versions_json: _::{tool_versions_json},
    error_count: _::{error_count},
    warning_count: _::{warning_count},
    metrics_json: _::{metrics_json},
  }

QUERY UpdateValidationStatus(
  validation_id: ID,
  status: String,
  error_count: U32,
  warning_count: U32,
  metrics_json: String,
  completed_at_ms: U64
) =>
  v <- N<ValidationRun>(validation_id)
  updated <- v::UPDATE({status: status, error_count: error_count, warning_count: warning_count, metrics_json: metrics_json, completed_at_ms: completed_at_ms})
  RETURN updated::{ status: _::{status}, error_count: _::{error_count} }

QUERY GetSnapshotValidations(snapshot_id: ID) =>
  validations <- N<Snapshot>(snapshot_id)::Out<HasValidation>
  RETURN validations::{
    validation_key: _::{validation_key},
    status: _::{status},
    error_count: _::{error_count},
    warning_count: _::{warning_count},
    created_at_ms: _::{created_at_ms},
  }

QUERY GetProposalValidations(proposal_id: ID) =>
  validations <- N<Proposal>(proposal_id)::Out<ProposalHasValidation>
  RETURN validations::{
    validation_key: _::{validation_key},
    status: _::{status},
    error_count: _::{error_count},
    warning_count: _::{warning_count},
    created_at_ms: _::{created_at_ms},
  }

QUERY DeleteValidationRun(validation_id: ID) =>
  DROP N<ValidationRun>(validation_id)
  RETURN "deleted"


// ============================================================================
// 14. DIAGNOSTIC CRUD
// ============================================================================

QUERY CreateDiagnostic(
  validation_id: ID,
  diagnostic_key: String,
  path: String,
  code: String,
  category: String,
  message: String,
  line: U32,
  column: U32,
  end_line: U32,
  end_column: U32,
  source: String,
  seq: U32
) =>
  diag <- AddN<Diagnostic>({
    diagnostic_key: diagnostic_key,
    path: path,
    code: code,
    category: category,
    message: message,
    line: line,
    column: column,
    end_line: end_line,
    end_column: end_column,
    source: source,
  })
  link <- AddE<ValidationHasDiagnostic>({seq: seq})::From(validation_id)::To(diag)
  RETURN diag::{ diagnostic_key: _::{diagnostic_key}, category: _::{category}, code: _::{code} }

QUERY GetValidationDiagnostics(validation_id: ID) =>
  diags <- N<ValidationRun>(validation_id)::Out<ValidationHasDiagnostic>
  RETURN diags::{
    diagnostic_key: _::{diagnostic_key},
    path: _::{path},
    code: _::{code},
    category: _::{category},
    message: _::{message},
    line: _::{line},
    column: _::{column},
    source: _::{source},
  }

QUERY GetDiagnosticsByCategory(validation_id: ID, category: String) =>
  diags <- N<ValidationRun>(validation_id)::Out<ValidationHasDiagnostic>::WHERE(_::{category}::EQ(category))
  RETURN diags::{
    path: _::{path},
    code: _::{code},
    message: _::{message},
    line: _::{line},
  }

QUERY DeleteDiagnostic(diagnostic_id: ID) =>
  DROP N<Diagnostic>(diagnostic_id)
  RETURN "deleted"


// ============================================================================
// 15. METRIC CRUD
// ============================================================================

QUERY CreateMetric(
  validation_id: ID,
  metric_key: String,
  name: String,
  value: F64,
  unit: String,
  metadata_json: String,
  now_ms: U64
) =>
  metric <- AddN<Metric>({
    metric_key: metric_key,
    name: name,
    value: value,
    unit: unit,
    metadata_json: metadata_json,
  })
  link <- AddE<ValidationHasMetric>({created_at_ms: now_ms})::From(validation_id)::To(metric)
  RETURN metric::{ metric_key: _::{metric_key}, name: _::{name}, value: _::{value} }

QUERY GetValidationMetrics(validation_id: ID) =>
  metrics <- N<ValidationRun>(validation_id)::Out<ValidationHasMetric>
  RETURN metrics::{
    metric_key: _::{metric_key},
    name: _::{name},
    value: _::{value},
    unit: _::{unit},
    metadata_json: _::{metadata_json},
  }

QUERY GetMetricByName(validation_id: ID, name: String) =>
  metrics <- N<ValidationRun>(validation_id)::Out<ValidationHasMetric>::WHERE(_::{name}::EQ(name))
  RETURN metrics::{ name: _::{name}, value: _::{value}, unit: _::{unit} }

QUERY DeleteMetric(metric_id: ID) =>
  DROP N<Metric>(metric_id)
  RETURN "deleted"


// ============================================================================
// 16. IMPORT GRAPH QUERIES
// ============================================================================

QUERY CreateImport(
  from_file_id: ID,
  to_file_id: ID,
  specifier: String,
  kind: String,
  is_type_only: Boolean
) =>
  edge <- AddE<Imports>({specifier: specifier, kind: kind, is_type_only: is_type_only})::From(from_file_id)::To(to_file_id)
  RETURN edge::{ specifier: _::{specifier}, kind: _::{kind} }

QUERY GetFileImports(file_id: ID) =>
  imports <- N<File>(file_id)::Out<Imports>
  RETURN imports::{ path: _::{path}, language: _::{language} }

QUERY GetFileImporters(file_id: ID) =>
  importers <- N<File>(file_id)::In<Imports>
  RETURN importers::{ path: _::{path}, language: _::{language} }

QUERY GetImportEdges(file_id: ID) =>
  edges <- N<File>(file_id)::OutE<Imports>
  RETURN edges::{ specifier: _::{specifier}, kind: _::{kind}, is_type_only: _::{is_type_only} }


// ============================================================================
// 17. DESIGN SNAPSHOT CRUD
// ============================================================================

QUERY CreateDesignSnapshot(
  repo_id: ID,
  design_key: String,
  repo_name: String,
  penpot_file_id: String,
  penpot_project_id: String,
  file_name: String,
  agentfs_path: String,
  sha256: String,
  size_bytes: U64,
  metadata_json: String,
  now_ms: U64
) =>
  design <- AddN<DesignSnapshot>({
    design_key: design_key,
    repo_name: repo_name,
    penpot_file_id: penpot_file_id,
    penpot_project_id: penpot_project_id,
    created_at_ms: now_ms,
    file_name: file_name,
    agentfs_path: agentfs_path,
    sha256: sha256,
    size_bytes: size_bytes,
    metadata_json: metadata_json,
  })
  link <- AddE<RepoHasDesign>({created_at_ms: now_ms})::From(repo_id)::To(design)
  RETURN design::{ design_key: _::{design_key}, file_name: _::{file_name} }

QUERY GetDesignSnapshot(design_id: ID) =>
  d <- N<DesignSnapshot>(design_id)
  RETURN d::{
    design_key: _::{design_key},
    repo_name: _::{repo_name},
    penpot_file_id: _::{penpot_file_id},
    penpot_project_id: _::{penpot_project_id},
    created_at_ms: _::{created_at_ms},
    file_name: _::{file_name},
    agentfs_path: _::{agentfs_path},
    sha256: _::{sha256},
    size_bytes: _::{size_bytes},
  }

QUERY ListRepoDesigns(repo_id: ID) =>
  designs <- N<Repo>(repo_id)::Out<RepoHasDesign>
  RETURN designs::{
    design_key: _::{design_key},
    file_name: _::{file_name},
    created_at_ms: _::{created_at_ms},
    sha256: _::{sha256},
  }

QUERY DeleteDesignSnapshot(design_id: ID) =>
  DROP N<DesignSnapshot>(design_id)
  RETURN "deleted"


// ============================================================================
// 18. PROPOSAL GRAPH QUERIES
// ============================================================================

QUERY CreateProposalDependency(from_proposal_id: ID, to_proposal_id: ID, kind: String, now_ms: U64) =>
  edge <- AddE<ProposalDependsOn>({kind: kind, created_at_ms: now_ms})::From(from_proposal_id)::To(to_proposal_id)
  RETURN edge::{ kind: _::{kind} }

QUERY GetProposalDependencies(proposal_id: ID) =>
  deps <- N<Proposal>(proposal_id)::Out<ProposalDependsOn>
  RETURN deps::{
    proposal_key: _::{proposal_key},
    status: _::{status},
    title: _::{title},
  }

QUERY GetProposalDependents(proposal_id: ID) =>
  dependents <- N<Proposal>(proposal_id)::In<ProposalDependsOn>
  RETURN dependents::{
    proposal_key: _::{proposal_key},
    status: _::{status},
    title: _::{title},
  }

QUERY GetConflictingProposals(proposal_id: ID) =>
  deps <- N<Proposal>(proposal_id)::Out<ProposalDependsOn>
  RETURN deps::{
    proposal_key: _::{proposal_key},
    status: _::{status},
  }


// ============================================================================
// 19. KEY-BASED QUERIES (bypass ID requirement)
// ============================================================================
// These queries use unique keys (repo_name, snapshot_key, proposal_key) instead
// of IDs for entity traversal. This works because child entities store their
// parent's name/key as a denormalized field.

QUERY ListSnapshotsByRepoName(repo_name: String) =>
  snapshots <- N<Snapshot>::WHERE(_::{repo_name}::EQ(repo_name))
  RETURN snapshots::{
    snapshot_key: _::{snapshot_key},
    repo_name: _::{repo_name},
    status: _::{status},
    created_at_ms: _::{created_at_ms},
    file_count: _::{file_count},
    total_bytes: _::{total_bytes},
    commit_sha: _::{commit_sha},
    parent_snapshot_id: _::{parent_snapshot_id},
  }

QUERY ListProposalsByRepoName(repo_name: String) =>
  proposals <- N<Proposal>::WHERE(_::{repo_name}::EQ(repo_name))
  RETURN proposals::{
    proposal_key: _::{proposal_key},
    repo_name: _::{repo_name},
    status: _::{status},
    title: _::{title},
    created_by: _::{created_by},
    created_at_ms: _::{created_at_ms},
    edit_count: _::{edit_count},
    base_snapshot_id: _::{base_snapshot_id},
  }

QUERY GetSnapshotFilesByKey(snapshot_key: String) =>
  s <- N<Snapshot>({snapshot_key: snapshot_key})
  files <- s::Out<SnapshotHasFile>
  RETURN files::{
    file_key: _::{file_key},
    path: _::{path},
    sha256: _::{sha256},
    language: _::{language},
    size_bytes: _::{size_bytes},
    line_count: _::{line_count},
  }

QUERY GetSnapshotFilesWithContentByKey(snapshot_key: String) =>
  s <- N<Snapshot>({snapshot_key: snapshot_key})
  files <- s::Out<SnapshotHasFile>
  RETURN files::{
    file_key: _::{file_key},
    path: _::{path},
    content: _::{content},
    sha256: _::{sha256},
    language: _::{language},
    size_bytes: _::{size_bytes},
    line_count: _::{line_count},
  }

QUERY GetProposalEditsByKey(proposal_key: String) =>
  p <- N<Proposal>({proposal_key: proposal_key})
  edits <- p::Out<ProposalHasEdit>
  RETURN edits::{
    edit_key: _::{edit_key},
    path: _::{path},
    kind: _::{kind},
    sha256: _::{sha256},
    old_path: _::{old_path},
  }

QUERY CreateSnapshotByRepoName(
  repo_name: String,
  snapshot_key: String,
  parent_snapshot_id: String,
  commit_sha: String,
  now_ms: U64,
  metadata_json: String,
  status: String
) =>
  repo <- N<Repo>({repo_name: repo_name})
  snapshot <- AddN<Snapshot>({
    snapshot_key: snapshot_key,
    repo_name: repo_name,
    parent_snapshot_id: parent_snapshot_id,
    created_at_ms: now_ms,
    file_count: 0,
    total_bytes: 0,
    commit_sha: commit_sha,
    status: status,
    metadata_json: metadata_json,
  })
  link <- AddE<RepoHasSnapshot>({created_at_ms: now_ms, is_head: false})::From(repo)::To(snapshot)
  RETURN snapshot::{ snapshot_key: _::{snapshot_key}, status: _::{status} }

QUERY CreateProposalByRepoName(
  repo_name: String,
  proposal_key: String,
  base_snapshot_id: String,
  created_by: String,
  title: String,
  description: String,
  now_ms: U64,
  metadata_json: String
) =>
  repo <- N<Repo>({repo_name: repo_name})
  proposal <- AddN<Proposal>({
    proposal_key: proposal_key,
    repo_name: repo_name,
    base_snapshot_id: base_snapshot_id,
    status: "draft",
    created_at_ms: now_ms,
    updated_at_ms: now_ms,
    created_by: created_by,
    title: title,
    description: description,
    edit_count: 0,
    metadata_json: metadata_json,
  })
  link <- AddE<RepoHasProposal>({created_at_ms: now_ms})::From(repo)::To(proposal)
  RETURN proposal::{ proposal_key: _::{proposal_key}, status: _::{status} }

QUERY AddFileToSnapshotByKey(
  snapshot_key: String,
  file_key: String,
  path: String,
  content: String,
  sha256: String,
  language: String,
  size_bytes: U64,
  line_count: U32,
  now_ms: U64
) =>
  snapshot <- N<Snapshot>({snapshot_key: snapshot_key})
  file <- AddN<File>({
    file_key: file_key,
    path: path,
    content: content,
    sha256: sha256,
    language: language,
    size_bytes: size_bytes,
    line_count: line_count,
    created_at_ms: now_ms,
  })
  link <- AddE<SnapshotHasFile>({created_at_ms: now_ms})::From(snapshot)::To(file)
  RETURN file::{ file_key: _::{file_key}, path: _::{path}, sha256: _::{sha256} }

QUERY AddEditToProposalByKey(
  proposal_key: String,
  edit_key: String,
  path: String,
  kind: String,
  content: String,
  sha256: String,
  old_path: String,
  now_ms: U64,
  seq: U32
) =>
  proposal <- N<Proposal>({proposal_key: proposal_key})
  edit <- AddN<FileEdit>({
    edit_key: edit_key,
    path: path,
    kind: kind,
    content: content,
    sha256: sha256,
    old_path: old_path,
    created_at_ms: now_ms,
  })
  link <- AddE<ProposalHasEdit>({created_at_ms: now_ms, seq: seq})::From(proposal)::To(edit)
  RETURN edit::{ edit_key: _::{edit_key}, path: _::{path}, kind: _::{kind} }

QUERY UpdateSnapshotStatusByKey(snapshot_key: String, status: String, file_count: U32, total_bytes: U64) =>
  s <- N<Snapshot>({snapshot_key: snapshot_key})
  updated <- s::UPDATE({status: status, file_count: file_count, total_bytes: total_bytes})
  RETURN updated::{ status: _::{status}, file_count: _::{file_count} }

QUERY UpdateSnapshotStatusOnlyByKey(snapshot_key: String, status: String) =>
  s <- N<Snapshot>({snapshot_key: snapshot_key})
  updated <- s::UPDATE({status: status})
  RETURN updated::{ status: _::{status} }

QUERY UpdateProposalStatusByKey(proposal_key: String, status: String, now_ms: U64) =>
  p <- N<Proposal>({proposal_key: proposal_key})
  updated <- p::UPDATE({status: status, updated_at_ms: now_ms})
  RETURN updated::{ status: _::{status} }

QUERY UpdateProposalEditCountByKey(proposal_key: String, edit_count: U32, now_ms: U64) =>
  p <- N<Proposal>({proposal_key: proposal_key})
  updated <- p::UPDATE({edit_count: edit_count, updated_at_ms: now_ms})
  RETURN updated::{ edit_count: _::{edit_count} }

QUERY UpdateRepoHeadByName(repo_name: String, head_snapshot_id: String, now_ms: U64) =>
  repo <- N<Repo>({repo_name: repo_name})
  updated <- repo::UPDATE({head_snapshot_id: head_snapshot_id, updated_at_ms: now_ms})
  RETURN updated::{ head_snapshot_id: _::{head_snapshot_id} }
