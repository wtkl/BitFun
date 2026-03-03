//! Session bridge: translates remote commands into local session operations.
//!
//! The mobile client sends encrypted commands (list sessions, send message, etc.)
//! which are decrypted and dispatched to the local SessionManager via the global
//! ConversationCoordinator.
//!
//! After a SendMessage command, a `RemoteEventForwarder` is registered as an
//! internal event subscriber so that streaming progress (text chunks, tool events,
//! turn completion, etc.) is encrypted and relayed back to the mobile client.

use anyhow::{anyhow, Result};
use log::{debug, error, info};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

use super::encryption;

/// Image sent from mobile as a base64 data-URL.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageAttachment {
    pub name: String,
    pub data_url: String,
}

/// Commands that the mobile client can send to the desktop.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "cmd", rename_all = "snake_case")]
pub enum RemoteCommand {
    GetWorkspaceInfo,
    ListRecentWorkspaces,
    SetWorkspace {
        path: String,
    },
    ListSessions {
        /// Filter by workspace path. If omitted, falls back to the desktop's current workspace.
        workspace_path: Option<String>,
        /// Max sessions to return per page (default 30, max 100).
        limit: Option<usize>,
        /// Zero-based offset for pagination.
        offset: Option<usize>,
    },
    CreateSession {
        agent_type: Option<String>,
        session_name: Option<String>,
        /// Workspace to bind the new session to. Falls back to the desktop's
        /// current workspace when not provided.
        workspace_path: Option<String>,
    },
    GetSessionMessages {
        session_id: String,
        limit: Option<usize>,
        before_message_id: Option<String>,
    },
    SendMessage {
        session_id: String,
        content: String,
        /// When provided, overrides the session's current agent type for this
        /// turn (e.g. "agentic", "Plan", "debug").
        agent_type: Option<String>,
        /// Images attached by the mobile user (base64 data-URL).
        images: Option<Vec<ImageAttachment>>,
    },
    CancelTask {
        session_id: String,
    },
    DeleteSession {
        session_id: String,
    },
    SubscribeSession {
        session_id: String,
    },
    UnsubscribeSession {
        session_id: String,
    },
    Ping,
}

/// Responses sent from desktop back to mobile.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "resp", rename_all = "snake_case")]
pub enum RemoteResponse {
    WorkspaceInfo {
        has_workspace: bool,
        path: Option<String>,
        project_name: Option<String>,
        git_branch: Option<String>,
    },
    RecentWorkspaces {
        workspaces: Vec<RecentWorkspaceEntry>,
    },
    WorkspaceUpdated {
        success: bool,
        path: Option<String>,
        project_name: Option<String>,
        error: Option<String>,
    },
    SessionList {
        sessions: Vec<SessionInfo>,
        /// Whether more sessions exist beyond this page.
        has_more: bool,
    },
    SessionCreated {
        session_id: String,
    },
    Messages {
        session_id: String,
        messages: Vec<ChatMessage>,
        has_more: bool,
    },
    MessageSent {
        session_id: String,
        turn_id: String,
    },
    StreamEvent {
        session_id: String,
        event_type: String,
        payload: serde_json::Value,
    },
    TaskCancelled {
        session_id: String,
    },
    SessionDeleted {
        session_id: String,
    },
    SessionSubscribed {
        session_id: String,
    },
    SessionUnsubscribed {
        session_id: String,
    },
    /// Pushed to mobile immediately after pairing – contains the desktop's
    /// current workspace info and session list so the mobile can display the
    /// same data as the desktop without extra round-trips.
    InitialSync {
        has_workspace: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        project_name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        git_branch: Option<String>,
        sessions: Vec<SessionInfo>,
        has_more_sessions: bool,
    },
    Pong,
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub session_id: String,
    pub name: String,
    pub agent_type: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: usize,
    /// Workspace path this session belongs to
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    /// Workspace display name (last path component)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub timestamp: String,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentWorkspaceEntry {
    pub path: String,
    pub name: String,
    pub last_opened: String,
}

/// An encrypted (data, nonce) pair ready to be sent over the relay.
pub type EncryptedPayload = (String, String);

/// Strip XML wrapper tags that the agent system adds to user input before storage.
/// e.g. "<user_query>\nHello\n</user_query>\n<system_reminder>...</system_reminder>"
/// → "Hello"
fn strip_user_input_tags(content: &str) -> String {
    let s = content.trim();
    // Extract inner content of <user_query>...</user_query>
    if s.starts_with("<user_query>") {
        if let Some(end) = s.find("</user_query>") {
            let inner = s["<user_query>".len()..end].trim();
            return inner.to_string();
        }
    }
    // Drop <system_reminder> section (can appear without <user_query> wrapper)
    if let Some(pos) = s.find("<system_reminder>") {
        return s[..pos].trim().to_string();
    }
    s.to_string()
}

/// Map mobile-friendly agent type names to the actual agent registry IDs.
fn resolve_agent_type(mobile_type: Option<&str>) -> &'static str {
    match mobile_type {
        Some("code") | Some("agentic") | Some("Agentic") => "agentic",
        Some("cowork") | Some("Cowork") => "Cowork",
        Some("plan") | Some("Plan") => "Plan",
        Some("debug") | Some("Debug") => "debug",
        _ => "agentic",
    }
}

/// Decode a `data:image/...;base64,...` URL and save it as a file.
/// Returns the absolute path to the saved image on success.
fn save_data_url_image(
    dir: &std::path::Path,
    name: &str,
    data_url: &str,
) -> Option<std::path::PathBuf> {
    use base64::{engine::general_purpose::STANDARD as B64, Engine};

    let (header, b64_data) = data_url.split_once(",")?;
    let ext = if header.contains("png") {
        "png"
    } else if header.contains("gif") {
        "gif"
    } else if header.contains("webp") {
        "webp"
    } else {
        "jpg"
    };

    let decoded = B64.decode(b64_data.trim()).ok()?;

    let stem = std::path::Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image");
    let ts = chrono::Utc::now().timestamp_millis();
    let filename = format!("{stem}_{ts}.{ext}");
    let path = dir.join(&filename);

    std::fs::write(&path, &decoded).ok()?;
    Some(path)
}

/// Bridges remote commands to local session operations.
pub struct RemoteServer {
    shared_secret: [u8; 32],
    active_subscriptions: std::sync::Mutex<std::collections::HashSet<String>>,
    stream_tx: mpsc::UnboundedSender<EncryptedPayload>,
}

impl Drop for RemoteServer {
    fn drop(&mut self) {
        if let Ok(subs) = self.active_subscriptions.lock() {
            for sub_id in subs.iter() {
                unregister_stream_forwarder(sub_id);
            }
        }
    }
}

impl RemoteServer {
    pub fn new(shared_secret: [u8; 32], stream_tx: mpsc::UnboundedSender<EncryptedPayload>) -> Self {
        Self {
            shared_secret,
            active_subscriptions: std::sync::Mutex::new(std::collections::HashSet::new()),
            stream_tx,
        }
    }

    pub fn shared_secret(&self) -> &[u8; 32] {
        &self.shared_secret
    }

    pub fn decrypt_command(
        &self,
        encrypted_data: &str,
        nonce: &str,
    ) -> Result<(RemoteCommand, Option<String>)> {
        let json = encryption::decrypt_from_base64(&self.shared_secret, encrypted_data, nonce)?;
        let value: Value = serde_json::from_str(&json).map_err(|e| anyhow!("parse json: {e}"))?;
        let request_id = value
            .get("_request_id")
            .and_then(|v| v.as_str())
            .map(String::from);
        let cmd: RemoteCommand =
            serde_json::from_value(value).map_err(|e| anyhow!("parse command: {e}"))?;
        Ok((cmd, request_id))
    }

    pub fn encrypt_response(
        &self,
        response: &RemoteResponse,
        request_id: Option<&str>,
    ) -> Result<EncryptedPayload> {
        let mut value =
            serde_json::to_value(response).map_err(|e| anyhow!("serialize response: {e}"))?;
        if let (Some(id), Some(obj)) = (request_id, value.as_object_mut()) {
            obj.insert("_request_id".to_string(), Value::String(id.to_string()));
        }
        let json = serde_json::to_string(&value).map_err(|e| anyhow!("to_string: {e}"))?;
        encryption::encrypt_to_base64(&self.shared_secret, &json)
    }

    pub async fn dispatch(&self, cmd: &RemoteCommand) -> RemoteResponse {
        match cmd {
            RemoteCommand::Ping => RemoteResponse::Pong,
            
            RemoteCommand::GetWorkspaceInfo |
            RemoteCommand::ListRecentWorkspaces |
            RemoteCommand::SetWorkspace { .. } => {
                self.handle_workspace_command(cmd).await
            }

            RemoteCommand::ListSessions { .. } |
            RemoteCommand::CreateSession { .. } |
            RemoteCommand::GetSessionMessages { .. } |
            RemoteCommand::DeleteSession { .. } => {
                self.handle_session_command(cmd).await
            }

            RemoteCommand::SendMessage { .. } |
            RemoteCommand::CancelTask { .. } => {
                self.handle_execution_command(cmd).await
            }

            RemoteCommand::SubscribeSession { .. } |
            RemoteCommand::UnsubscribeSession { .. } => {
                self.handle_subscription_command(cmd).await
            }
        }
    }

    /// Build the initial sync payload that is pushed to the mobile right after
    /// pairing completes. This reads the same disk source as the desktop UI's
    /// `get_conversation_sessions` so the session lists are guaranteed consistent.
    pub async fn generate_initial_sync(&self) -> RemoteResponse {
        use crate::infrastructure::{get_workspace_path, PathManager};
        use crate::service::conversation::ConversationPersistenceManager;

        let ws_path = get_workspace_path();
        let (has_workspace, path_str, project_name, git_branch) = if let Some(ref p) = ws_path {
            let name = p.file_name().map(|n| n.to_string_lossy().to_string());
            let branch = git2::Repository::open(p)
                .ok()
                .and_then(|repo| repo.head().ok().and_then(|h| h.shorthand().map(String::from)));
            (true, Some(p.to_string_lossy().to_string()), name, branch)
        } else {
            (false, None, None, None)
        };

        let (sessions, has_more) = if let Some(ref wp) = ws_path {
            let ws_str = wp.to_string_lossy().to_string();
            let ws_name = wp.file_name().map(|n| n.to_string_lossy().to_string());
            if let Ok(pm) = PathManager::new() {
                let pm = std::sync::Arc::new(pm);
                if let Ok(conv_mgr) = ConversationPersistenceManager::new(pm, wp.clone()).await {
                    if let Ok(all_meta) = conv_mgr.get_session_list().await {
                        let total = all_meta.len();
                        let page_size = 100usize;
                        let has_more = total > page_size;
                        let sessions: Vec<SessionInfo> = all_meta
                            .into_iter()
                            .take(page_size)
                            .map(|s| SessionInfo {
                                session_id: s.session_id,
                                name: s.session_name,
                                agent_type: s.agent_type,
                                created_at: (s.created_at / 1000).to_string(),
                                updated_at: (s.last_active_at / 1000).to_string(),
                                message_count: s.message_count,
                                workspace_path: Some(ws_str.clone()),
                                workspace_name: ws_name.clone(),
                            })
                            .collect();
                        (sessions, has_more)
                    } else {
                        (vec![], false)
                    }
                } else {
                    (vec![], false)
                }
            } else {
                (vec![], false)
            }
        } else {
            (vec![], false)
        };

        RemoteResponse::InitialSync {
            has_workspace,
            path: path_str,
            project_name,
            git_branch,
            sessions,
            has_more_sessions: has_more,
        }
    }

    async fn handle_workspace_command(&self, cmd: &RemoteCommand) -> RemoteResponse {
        use crate::infrastructure::get_workspace_path;
        use crate::service::workspace::get_global_workspace_service;

        match cmd {
            RemoteCommand::GetWorkspaceInfo => {
                let ws_path = get_workspace_path();
                let (project_name, git_branch) = if let Some(ref p) = ws_path {
                    let name = p
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string());
                    let branch = git2::Repository::open(p)
                        .ok()
                        .and_then(|repo| {
                            repo.head()
                                .ok()
                                .and_then(|h| h.shorthand().map(String::from))
                        });
                    (name, branch)
                } else {
                    (None, None)
                };
                RemoteResponse::WorkspaceInfo {
                    has_workspace: ws_path.is_some(),
                    path: ws_path.map(|p| p.to_string_lossy().to_string()),
                    project_name,
                    git_branch,
                }
            }
            RemoteCommand::ListRecentWorkspaces => {
                let ws_service = match get_global_workspace_service() {
                    Some(s) => s,
                    None => {
                        return RemoteResponse::RecentWorkspaces {
                            workspaces: vec![],
                        };
                    }
                };
                let recent = ws_service.get_recent_workspaces().await;
                let entries = recent
                    .into_iter()
                    .map(|w| RecentWorkspaceEntry {
                        path: w.root_path.to_string_lossy().to_string(),
                        name: w.name.clone(),
                        last_opened: w.last_accessed.to_rfc3339(),
                    })
                    .collect();
                RemoteResponse::RecentWorkspaces { workspaces: entries }
            }
            RemoteCommand::SetWorkspace { path } => {
                let ws_service = match get_global_workspace_service() {
                    Some(s) => s,
                    None => {
                        return RemoteResponse::WorkspaceUpdated {
                            success: false,
                            path: None,
                            project_name: None,
                            error: Some("Workspace service not available".into()),
                        };
                    }
                };
                let path_buf = std::path::PathBuf::from(path);
                match ws_service.open_workspace(path_buf).await {
                    Ok(info) => {
                        if let Err(e) =
                            crate::service::snapshot::initialize_global_snapshot_manager(
                                info.root_path.clone(),
                                None,
                            )
                            .await
                        {
                            error!("Failed to initialize snapshot after remote workspace set: {e}");
                        }
                        RemoteResponse::WorkspaceUpdated {
                            success: true,
                            path: Some(info.root_path.to_string_lossy().to_string()),
                            project_name: Some(info.name.clone()),
                            error: None,
                        }
                    }
                    Err(e) => RemoteResponse::WorkspaceUpdated {
                        success: false,
                        path: None,
                        project_name: None,
                        error: Some(e.to_string()),
                    },
                }
            }
            _ => RemoteResponse::Error { message: "Unknown workspace command".into() },
        }
    }

    async fn handle_session_command(&self, cmd: &RemoteCommand) -> RemoteResponse {
        use crate::agentic::{coordination::get_global_coordinator, core::SessionConfig};

        let coordinator = match get_global_coordinator() {
            Some(c) => c,
            None => {
                return RemoteResponse::Error {
                    message: "Desktop session system not ready".into(),
                };
            }
        };

        match cmd {
            RemoteCommand::ListSessions { workspace_path, limit, offset } => {
                // Only query the explicitly-requested workspace (or fall back to the
                // desktop's current workspace when none is specified).  Sessions are
                // served page-by-page so the frontend never needs to receive more than
                // it intends to display.
                use crate::infrastructure::{get_workspace_path, PathManager};
                use crate::service::conversation::ConversationPersistenceManager;

                let page_size = limit.unwrap_or(30).min(100);
                let page_offset = offset.unwrap_or(0);

                // Resolve which workspace to query
                let effective_ws: Option<std::path::PathBuf> = workspace_path
                    .as_deref()
                    .map(std::path::PathBuf::from)
                    .or_else(|| get_workspace_path());

                if let Some(ref wp) = effective_ws {
                    let ws_str = wp.to_string_lossy().to_string();
                    let workspace_name = wp.file_name()
                        .map(|n| n.to_string_lossy().to_string());

                    if let Ok(pm) = PathManager::new() {
                        let pm = std::sync::Arc::new(pm);
                        match ConversationPersistenceManager::new(pm, wp.clone()).await {
                            Ok(conv_mgr) => {
                                match conv_mgr.get_session_list().await {
                                    Ok(all_meta) => {
                                        // The list is already sorted by last_active_at desc
                                        // at persistence time; apply server-side pagination.
                                        let total = all_meta.len();
                                        let has_more = page_offset + page_size < total;
                                        let sessions: Vec<SessionInfo> = all_meta
                                            .into_iter()
                                            .skip(page_offset)
                                            .take(page_size)
                                            .map(|s| {
                                                let created = (s.created_at / 1000).to_string();
                                                let updated = (s.last_active_at / 1000).to_string();
                                                SessionInfo {
                                                    session_id: s.session_id,
                                                    name: s.session_name,
                                                    agent_type: s.agent_type,
                                                    created_at: created,
                                                    updated_at: updated,
                                                    message_count: s.message_count,
                                                    workspace_path: Some(ws_str.clone()),
                                                    workspace_name: workspace_name.clone(),
                                                }
                                            })
                                            .collect();
                                        return RemoteResponse::SessionList { sessions, has_more };
                                    }
                                    Err(e) => debug!("Session list read failed for {ws_str}: {e}"),
                                }
                            }
                            Err(e) => debug!("ConversationPersistenceManager init failed for {ws_str}: {e}"),
                        }
                    }
                }

                // Fallback: global in-memory sessions (no workspace available)
                match coordinator.list_sessions().await {
                    Ok(summaries) => {
                        let total = summaries.len();
                        let has_more = page_offset + page_size < total;
                        let sessions = summaries
                            .into_iter()
                            .skip(page_offset)
                            .take(page_size)
                            .map(|s| {
                                let created = s.created_at
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_secs()
                                    .to_string();
                                let updated = s.last_activity_at
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_secs()
                                    .to_string();
                                SessionInfo {
                                    session_id: s.session_id,
                                    name: s.session_name,
                                    agent_type: s.agent_type,
                                    created_at: created,
                                    updated_at: updated,
                                    message_count: s.turn_count,
                                    workspace_path: None,
                                    workspace_name: None,
                                }
                            })
                            .collect();
                        RemoteResponse::SessionList { sessions, has_more }
                    }
                    Err(e) => RemoteResponse::Error { message: e.to_string() },
                }
            }
            RemoteCommand::CreateSession {
                agent_type,
                session_name: custom_name,
                workspace_path: requested_ws_path,
            } => {
                use crate::infrastructure::{get_workspace_path, PathManager};
                use crate::service::conversation::{ConversationPersistenceManager, SessionMetadata, SessionStatus};

                let agent = resolve_agent_type(agent_type.as_deref());
                let session_name = custom_name
                    .as_deref()
                    .filter(|n| !n.is_empty())
                    .unwrap_or(match agent {
                        "Cowork" => "Remote Cowork Session",
                        _ => "Remote Code Session",
                    });
                // Determine the binding workspace BEFORE creating the session so that
                // the workspace_path can be embedded in the SessionCreated event.
                // This allows the desktop UI to filter out sessions from other workspaces.
                let binding_ws_path: Option<std::path::PathBuf> = requested_ws_path
                    .as_deref()
                    .map(std::path::PathBuf::from)
                    .or_else(|| get_workspace_path());
                let binding_ws_str = binding_ws_path.as_ref()
                    .map(|p| p.to_string_lossy().to_string());

                debug!("Remote CreateSession: requested_ws={:?}, binding_ws={:?}", requested_ws_path, binding_ws_str);
                match coordinator
                    .create_session_with_workspace(
                        None,
                        session_name.to_string(),
                        agent.to_string(),
                        SessionConfig::default(),
                        binding_ws_str.clone(),
                    )
                    .await
                {
                    Ok(session) => {
                        let session_id = session.session_id.clone();

                        if let Some(wp) = binding_ws_path {
                            if let Ok(pm) = PathManager::new() {
                                let pm = std::sync::Arc::new(pm);
                                if let Ok(conv_mgr) = ConversationPersistenceManager::new(pm, wp.clone()).await {
                                    let now_ms = std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .unwrap_or_default()
                                        .as_millis() as u64;
                                    let meta = SessionMetadata {
                                        session_id: session_id.clone(),
                                        session_name: session_name.to_string(),
                                        agent_type: agent.to_string(),
                                        model_name: "default".to_string(),
                                        created_at: now_ms,
                                        last_active_at: now_ms,
                                        turn_count: 0,
                                        message_count: 0,
                                        tool_call_count: 0,
                                        status: SessionStatus::Active,
                                        terminal_session_id: None,
                                        snapshot_session_id: None,
                                        tags: vec![],
                                        custom_metadata: None,
                                        todos: None,
                                        workspace_path: binding_ws_str,
                                    };
                                    if let Err(e) = conv_mgr.save_session_metadata(&meta).await {
                                        error!("Failed to sync remote session to workspace: {e}");
                                    } else {
                                        info!("Remote session synced to workspace: {session_id}");
                                    }
                                }
                            }
                        }

                        RemoteResponse::SessionCreated { session_id }
                    }
                    Err(e) => RemoteResponse::Error {
                        message: e.to_string(),
                    },
                }
            }
            RemoteCommand::GetSessionMessages { session_id, limit, before_message_id } => {
                let limit = limit.unwrap_or(50);
                let session_mgr = coordinator.get_session_manager();
                if session_mgr.get_session(session_id).is_none() {
                    let _ = coordinator.restore_session(session_id).await;
                }
                match coordinator.get_messages_paginated(session_id, limit, before_message_id.as_deref()).await {
                    Ok((messages, has_more)) => {
                        let chat_msgs = messages
                            .into_iter()
                            .map(|m| {
                                use crate::agentic::core::MessageRole;
                                let role = match m.role {
                                    MessageRole::User => "user",
                                    MessageRole::Assistant => "assistant",
                                    MessageRole::Tool => "tool",
                                    MessageRole::System => "system",
                                };
                                let raw_content = match &m.content {
                                    crate::agentic::core::MessageContent::Text(t) => t.clone(),
                                    crate::agentic::core::MessageContent::Mixed {
                                        text, ..
                                    } => text.clone(),
                                    crate::agentic::core::MessageContent::ToolResult {
                                        result_for_assistant,
                                        result,
                                        ..
                                    } => result_for_assistant
                                        .clone()
                                        .unwrap_or_else(|| result.to_string()),
                                };
                                // Strip agent-internal XML tags from user messages
                                let content = if matches!(m.role, MessageRole::User) {
                                    strip_user_input_tags(&raw_content)
                                } else {
                                    raw_content
                                };
                                let ts = m
                                    .timestamp
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_secs()
                                    .to_string();
                                ChatMessage {
                                    id: m.id.clone(),
                                    role: role.to_string(),
                                    content,
                                    timestamp: ts,
                                    metadata: None,
                                }
                            })
                            .collect();
                        RemoteResponse::Messages {
                            session_id: session_id.clone(),
                            messages: chat_msgs,
                            has_more,
                        }
                    }
                    Err(e) => {
                        RemoteResponse::Error {
                            message: e.to_string(),
                        }
                    }
                }
            }
            RemoteCommand::DeleteSession { session_id } => {
                match coordinator.delete_session(session_id).await {
                    Ok(_) => RemoteResponse::SessionDeleted {
                        session_id: session_id.clone(),
                    },
                    Err(e) => RemoteResponse::Error {
                        message: e.to_string(),
                    },
                }
            }
            _ => RemoteResponse::Error { message: "Unknown session command".into() },
        }
    }

    async fn handle_execution_command(&self, cmd: &RemoteCommand) -> RemoteResponse {
        use crate::agentic::coordination::get_global_coordinator;

        let coordinator = match get_global_coordinator() {
            Some(c) => c,
            None => {
                return RemoteResponse::Error {
                    message: "Desktop session system not ready".into(),
                };
            }
        };

        match cmd {
            RemoteCommand::SendMessage {
                session_id,
                content,
                agent_type: requested_agent_type,
                images,
            } => {
                let session_mgr = coordinator.get_session_manager();
                let (session_agent_type, session_ws) = session_mgr
                    .get_session(session_id)
                    .map(|s| (s.agent_type.clone(), s.config.workspace_path.clone()))
                    .unwrap_or_else(|| ("default".to_string(), None));

                let agent_type = requested_agent_type
                    .as_deref()
                    .map(|t| resolve_agent_type(Some(t)).to_string())
                    .unwrap_or(session_agent_type);

                if let Some(ws_path_str) = &session_ws {
                    use crate::infrastructure::{get_workspace_path, set_workspace_path};
                    let current = get_workspace_path();
                    let current_str = current.as_ref().map(|p| p.to_string_lossy().to_string());
                    if current_str.as_deref() != Some(ws_path_str.as_str()) {
                        info!("Remote send_message: temporarily setting workspace for session={session_id} to {ws_path_str}");
                        set_workspace_path(Some(std::path::PathBuf::from(ws_path_str)));
                    }
                }

                let full_content = if let Some(imgs) = &images {
                    if imgs.is_empty() {
                        content.clone()
                    } else {
                        let save_dir = if let Some(ws) = &session_ws {
                            let d = std::path::PathBuf::from(ws)
                                .join(".bitfun")
                                .join("remote-images");
                            let _ = std::fs::create_dir_all(&d);
                            Some(d)
                        } else {
                            None
                        };

                        let mut extra = String::new();
                        for (i, img) in imgs.iter().enumerate() {
                            if let Some(ref dir) = save_dir {
                                if let Some(saved) = save_data_url_image(dir, &img.name, &img.data_url) {
                                    let path_str = saved.to_string_lossy();
                                    extra.push_str(&format!(
                                        "\n\n[Image: {}]\nPath: {}\nTip: You can use the AnalyzeImage tool with the image_path parameter.",
                                        img.name, path_str
                                    ));
                                    info!("Remote image {i} saved: {path_str}");
                                    continue;
                                }
                            }
                            extra.push_str(&format!(
                                "\n\n[Image: {} (inline)]\nData URL provided inline.\nTip: You can use the AnalyzeImage tool with the data_url parameter.",
                                img.name
                            ));
                        }
                        format!("{content}{extra}")
                    }
                } else {
                    content.clone()
                };

                info!("Remote send_message: session={session_id}, agent_type={agent_type}, images={}", images.as_ref().map_or(0, |v| v.len()));
                let turn_id = format!("turn_{}", chrono::Utc::now().timestamp_millis());
                match coordinator
                    .start_dialog_turn(
                        session_id.clone(),
                        full_content,
                        Some(turn_id.clone()),
                        agent_type,
                        true,
                    )
                    .await
                {
                    Ok(()) => RemoteResponse::MessageSent {
                        session_id: session_id.clone(),
                        turn_id,
                    },
                    Err(e) => RemoteResponse::Error {
                        message: e.to_string(),
                    },
                }
            }
            RemoteCommand::CancelTask { session_id } => {
                let session_mgr = coordinator.get_session_manager();
                if let Some(session) = session_mgr.get_session(session_id) {
                    use crate::agentic::core::SessionState;
                    let _ = session_mgr
                        .update_session_state(session_id, SessionState::Idle)
                        .await;
                    if let Some(last_turn_id) = session.dialog_turn_ids.last() {
                        let _ = coordinator.cancel_dialog_turn(session_id, last_turn_id).await;
                    }
                }
                RemoteResponse::TaskCancelled {
                    session_id: session_id.clone(),
                }
            }
            _ => RemoteResponse::Error { message: "Unknown execution command".into() },
        }
    }

    async fn handle_subscription_command(&self, cmd: &RemoteCommand) -> RemoteResponse {
        match cmd {
            RemoteCommand::SubscribeSession { session_id } => {
                let subscriber_id = format!("remote_stream_{}", session_id);
                
                let mut subs = self.active_subscriptions.lock().unwrap();
                if !subs.contains(&subscriber_id) {
                    if let Some((sub_id, mut stream_rx)) = register_stream_forwarder(session_id, self.shared_secret) {
                        subs.insert(sub_id.clone());
                        
                        let stream_tx = self.stream_tx.clone();
                        tokio::spawn(async move {
                            while let Some(payload) = stream_rx.recv().await {
                                let _ = stream_tx.send(payload);
                            }
                            debug!("Stream forwarder channel closed: {sub_id}");
                        });
                    }
                }
                
                RemoteResponse::SessionSubscribed {
                    session_id: session_id.clone(),
                }
            }
            RemoteCommand::UnsubscribeSession { session_id } => {
                let subscriber_id = format!("remote_stream_{}", session_id);
                
                let mut subs = self.active_subscriptions.lock().unwrap();
                if subs.remove(&subscriber_id) {
                    unregister_stream_forwarder(&subscriber_id);
                }
                
                RemoteResponse::SessionUnsubscribed {
                    session_id: session_id.clone(),
                }
            }
            _ => RemoteResponse::Error { message: "Unknown subscription command".into() },
        }
    }
}

// ── Stream event forwarding ──────────────────────────────────────

/// Converts `AgenticEvent`s for a specific session into encrypted relay
/// payloads and sends them through a channel.
pub struct RemoteEventForwarder {
    target_session_id: String,
    shared_secret: [u8; 32],
    payload_tx: mpsc::UnboundedSender<EncryptedPayload>,
}

impl RemoteEventForwarder {
    pub fn new(
        target_session_id: String,
        shared_secret: [u8; 32],
        payload_tx: mpsc::UnboundedSender<EncryptedPayload>,
    ) -> Self {
        Self {
            target_session_id,
            shared_secret,
            payload_tx,
        }
    }

    fn try_forward(&self, event: &crate::agentic::events::AgenticEvent) {
        use bitfun_events::AgenticEvent as AE;

        // Check if this is a direct event for our session, or a subagent event
        // whose parent session is our target. Subagent events carry subagent_parent_info
        // with the parent session id. We forward both cases so the mobile can see
        // subagent tool calls and streaming text as part of the main session.
        let is_direct = event.session_id() == Some(self.target_session_id.as_str());
        let parent_turn_id: Option<String> = if !is_direct {
            match event {
                AE::TextChunk { subagent_parent_info, .. }
                | AE::ThinkingChunk { subagent_parent_info, .. }
                | AE::ToolEvent { subagent_parent_info, .. } => {
                    subagent_parent_info.as_ref().and_then(|p| {
                        if p.session_id == self.target_session_id {
                            Some(p.dialog_turn_id.clone())
                        } else {
                            None
                        }
                    })
                }
                _ => None,
            }
        } else {
            None
        };

        // Only proceed if this is a direct event or a relevant subagent event
        if !is_direct && parent_turn_id.is_none() {
            return;
        }

        let session_id = self.target_session_id.clone();

        let (event_type, payload) = match event {
            AE::TextChunk { text, turn_id, .. } => {
                // For subagent text chunks, use the parent turn_id so mobile groups them correctly
                let effective_turn_id = parent_turn_id.as_deref().unwrap_or(turn_id.as_str());
                (
                    "text_chunk",
                    serde_json::json!({ "text": text, "turn_id": effective_turn_id }),
                )
            }
            AE::ThinkingChunk {
                content, turn_id, ..
            } => {
                // Strip model-internal boundary markers (e.g. <thinking_end>) from thinking content
                let clean_content = content
                    .replace("<thinking_end>", "")
                    .replace("</thinking>", "")
                    .replace("<thinking>", "");
                let effective_turn_id = parent_turn_id.as_deref().unwrap_or(turn_id.as_str());
                (
                    "thinking_chunk",
                    serde_json::json!({ "content": clean_content, "turn_id": effective_turn_id }),
                )
            }
            AE::ToolEvent {
                tool_event,
                turn_id,
                ..
            } => {
                let effective_turn_id = parent_turn_id.as_deref().unwrap_or(turn_id.as_str());
                (
                    "tool_event",
                    serde_json::json!({
                        "turn_id": effective_turn_id,
                        "tool_event": serde_json::to_value(tool_event).unwrap_or_default(),
                    }),
                )
            }
            // The following events are only forwarded for the direct (main) session
            AE::DialogTurnStarted {
                turn_id,
                user_input,
                ..
            } => (
                "stream_start",
                serde_json::json!({ "turn_id": turn_id, "user_input": strip_user_input_tags(user_input) }),
            ),
            AE::DialogTurnCompleted {
                turn_id,
                total_rounds,
                duration_ms,
                ..
            } => (
                "stream_end",
                serde_json::json!({
                    "turn_id": turn_id,
                    "total_rounds": total_rounds,
                    "duration_ms": duration_ms,
                }),
            ),
            AE::DialogTurnFailed {
                turn_id, error, ..
            } => (
                "stream_error",
                serde_json::json!({ "turn_id": turn_id, "error": error }),
            ),
            AE::DialogTurnCancelled { turn_id, .. } => (
                "stream_cancelled",
                serde_json::json!({ "turn_id": turn_id }),
            ),
            AE::ModelRoundStarted {
                turn_id,
                round_index,
                ..
            } => (
                "round_started",
                serde_json::json!({ "turn_id": turn_id, "round_index": round_index }),
            ),
            AE::ModelRoundCompleted {
                turn_id,
                has_tool_calls,
                ..
            } => (
                "round_completed",
                serde_json::json!({ "turn_id": turn_id, "has_tool_calls": has_tool_calls }),
            ),
            AE::SessionStateChanged { new_state, .. } => (
                "session_state_changed",
                serde_json::json!({ "new_state": new_state }),
            ),
            AE::SessionTitleGenerated { title, .. } => (
                "session_title",
                serde_json::json!({ "title": title }),
            ),
            _ => return,
        };

        let resp = RemoteResponse::StreamEvent {
            session_id,
            event_type: event_type.to_string(),
            payload,
        };

        match encryption::encrypt_to_base64(
            &self.shared_secret,
            &serde_json::to_string(&resp).unwrap_or_default(),
        ) {
            Ok(encrypted) => {
                let _ = self.payload_tx.send(encrypted);
            }
            Err(e) => {
                error!("Failed to encrypt stream event: {e}");
            }
        }
    }
}

#[async_trait::async_trait]
impl crate::agentic::events::EventSubscriber for RemoteEventForwarder {
    async fn on_event(
        &self,
        event: &crate::agentic::events::AgenticEvent,
    ) -> crate::util::errors::BitFunResult<()> {
        self.try_forward(event);
        Ok(())
    }
}

/// Register a forwarder for a session. Returns the subscriber_id (for later unsubscription)
/// and the receiving end of the encrypted payload channel.
pub fn register_stream_forwarder(
    session_id: &str,
    shared_secret: [u8; 32],
) -> Option<(String, mpsc::UnboundedReceiver<EncryptedPayload>)> {
    use crate::agentic::coordination::get_global_coordinator;

    let coordinator = get_global_coordinator()?;
    let (tx, rx) = mpsc::unbounded_channel();
    let subscriber_id = format!("remote_stream_{}", session_id);

    let forwarder = RemoteEventForwarder::new(session_id.to_string(), shared_secret, tx);

    coordinator.subscribe_internal(subscriber_id.clone(), forwarder);
    info!("Registered remote stream forwarder: {subscriber_id}");
    Some((subscriber_id, rx))
}

/// Unregister a previously registered forwarder.
pub fn unregister_stream_forwarder(subscriber_id: &str) {
    use crate::agentic::coordination::get_global_coordinator;

    if let Some(coordinator) = get_global_coordinator() {
        coordinator.unsubscribe_internal(subscriber_id);
        info!("Unregistered remote stream forwarder: {subscriber_id}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::remote_connect::encryption::KeyPair;

    #[test]
    fn test_command_round_trip() {
        let alice = KeyPair::generate();
        let bob = KeyPair::generate();
        let shared = alice.derive_shared_secret(&bob.public_key_bytes());

        let (stream_tx, _stream_rx) = mpsc::unbounded_channel::<EncryptedPayload>();
        let bridge = RemoteServer::new(shared, stream_tx);

        let cmd_json = serde_json::json!({
            "cmd": "send_message",
            "session_id": "sess-123",
            "content": "Hello from mobile!",
            "_request_id": "req_abc"
        });
        let json = cmd_json.to_string();
        let (enc, nonce) = encryption::encrypt_to_base64(&shared, &json).unwrap();
        let (decoded, req_id) = bridge.decrypt_command(&enc, &nonce).unwrap();

        assert_eq!(req_id.as_deref(), Some("req_abc"));
        if let RemoteCommand::SendMessage {
            session_id,
            content,
        } = decoded
        {
            assert_eq!(session_id, "sess-123");
            assert_eq!(content, "Hello from mobile!");
        } else {
            panic!("unexpected command variant");
        }
    }

    #[test]
    fn test_response_with_request_id() {
        let alice = KeyPair::generate();
        let shared = alice.derive_shared_secret(&alice.public_key_bytes());
        let (stream_tx, _stream_rx) = mpsc::unbounded_channel::<EncryptedPayload>();
        let bridge = RemoteServer::new(shared, stream_tx);

        let resp = RemoteResponse::Pong;
        let (enc, nonce) = bridge.encrypt_response(&resp, Some("req_xyz")).unwrap();

        let json = encryption::decrypt_from_base64(&shared, &enc, &nonce).unwrap();
        let value: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["resp"], "pong");
        assert_eq!(value["_request_id"], "req_xyz");
    }
}
