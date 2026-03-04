use crate::agentic::tools::framework::{
    Tool, ToolRenderOptions, ToolResult, ToolUseContext, ValidationResult,
};
use crate::infrastructure::events::event_system::get_global_event_system;
use crate::infrastructure::events::event_system::BackendEvent::ToolExecutionProgress;
use crate::infrastructure::get_workspace_path;
use crate::service::config::global::get_global_config_service;
use crate::util::errors::{BitFunError, BitFunResult};
use crate::util::types::event::ToolExecutionProgressInfo;
use async_trait::async_trait;
use futures::StreamExt;
use log::{debug, error};
use serde_json::{json, Value};
use std::time::Instant;
use terminal_core::shell::{ShellDetector, ShellType};
use terminal_core::{
    CommandStreamEvent, ExecuteCommandRequest, SignalRequest, TerminalApi, TerminalBindingOptions,
};
use tool_runtime::util::ansi_cleaner::strip_ansi;

const MAX_OUTPUT_LENGTH: usize = 30000;

const BANNED_COMMANDS: &[&str] = &[
    "alias",
    "curl",
    "curlie",
    "wget",
    "axel",
    "aria2c",
    "nc",
    "telnet",
    "lynx",
    "w3m",
    "links",
    "httpie",
    "xh",
    "http-prompt",
    "chrome",
    "firefox",
    "safari",
];

fn truncate_string_by_chars(s: &str, max_chars: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    chars[..max_chars].into_iter().collect()
}

/// Result of shell resolution for bash tool
struct ResolvedShell {
    /// Shell type to use (None means use system default)
    shell_type: Option<ShellType>,
    /// Display name for the shell (for tool description)
    display_name: String,
}

/// Bash tool
pub struct BashTool;

impl BashTool {
    pub fn new() -> Self {
        Self
    }

    /// Resolve shell configuration for bash tool.
    /// If configured shell doesn't support integration, falls back to system default.
    async fn resolve_shell() -> ResolvedShell {
        // Try configured shell first, fall back to system default
        Self::try_configured_shell()
            .await
            .unwrap_or_else(Self::system_default_shell)
    }

    /// Try to get a valid configured shell that supports integration.
    async fn try_configured_shell() -> Option<ResolvedShell> {
        let config_service = get_global_config_service().await.ok()?;
        let shell_str: String = config_service
            .get_config::<String>(Some("terminal.default_shell"))
            .await
            .ok()
            .filter(|s| !s.is_empty())?;

        let parsed = ShellType::from_executable(&shell_str);
        if parsed.supports_integration() {
            Some(ResolvedShell {
                shell_type: Some(parsed.clone()),
                display_name: parsed.name().to_string(),
            })
        } else {
            debug!(
                "Configured shell '{}' does not support integration, using system default",
                shell_str
            );
            None
        }
    }

    /// Get system default shell configuration.
    fn system_default_shell() -> ResolvedShell {
        let detected = ShellDetector::get_default_shell();
        ResolvedShell {
            shell_type: None,
            display_name: detected.display_name,
        }
    }

    fn render_result(&self, output_text: &str, interrupted: bool, exit_code: i32) -> String {
        let mut result_string = String::new();

        // Exit code
        result_string.push_str(&format!("<exit_code>{}</exit_code>", exit_code));

        // Main output content
        if !output_text.is_empty() {
            let cleaned_output = strip_ansi(output_text);
            let output_len = cleaned_output.chars().count();
            if output_len > MAX_OUTPUT_LENGTH {
                let truncated = truncate_string_by_chars(&cleaned_output, MAX_OUTPUT_LENGTH);
                result_string.push_str(&format!(
                    "<output truncated=\"true\">{}</output>",
                    truncated
                ));
            } else {
                result_string.push_str(&format!("<output>{}</output>", cleaned_output));
            }
        }

        // Interruption notice
        if interrupted {
            result_string.push_str(
                "<status type=\"interrupted\">Command was canceled by the user. ASK THE USER what they would like to do next.</status>"
            );
        }

        result_string
    }
}

#[async_trait]
impl Tool for BashTool {
    fn name(&self) -> &str {
        "Bash"
    }

    async fn description(&self) -> BitFunResult<String> {
        let shell_info = Self::resolve_shell().await.display_name;

        Ok(format!(
            r#"Executes a given command in a persistent shell session with optional timeout, ensuring proper handling and security measures.

Shell Environment: {shell_info}

IMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.

Before executing the command, please follow these steps:

1. Directory Verification:
   - If the command will create new directories or files, first use `ls` to verify the parent directory exists and is the correct location
   - For example, before running "mkdir foo/bar", first use `ls foo` to check that "foo" exists and is the intended parent directory

2. Command Execution:
   - Always quote file paths that contain spaces with double quotes (e.g., cd "path with spaces/file.txt")
   - Examples of proper quoting:
     - cd "/Users/name/My Documents" (correct)
     - cd /Users/name/My Documents (incorrect - will fail)
     - python "/path/with spaces/script.py" (correct)
     - python /path/with spaces/script.py (incorrect - will fail)
   - After ensuring proper quoting, execute the command.
   - Capture the output of the command.

Usage notes:
  - The command argument is required and MUST be a single-line command.
  - DO NOT use multiline commands or HEREDOC syntax (e.g., <<EOF, heredoc with newlines). Only single-line commands are supported.
  - You can specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). If not specified, commands will timeout after 120000ms (2 minutes).
  - It is very helpful if you write a clear, concise description of what this command does. For simple commands, keep it brief (5-10 words). For complex commands (piped commands, obscure flags, or anything hard to understand at a glance), add enough context to clarify what it does.
  - If the output exceeds {MAX_OUTPUT_LENGTH} characters, output will be truncated before being returned to you.
  - You can use the `run_in_background` parameter to run the command in the background. Only use this if you don't need the result immediately. You do not need to use '&' at the end of the command when using this parameter.
  
  - Avoid using this tool with the `find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo` commands, unless explicitly instructed or when these commands are truly necessary for the task. Instead, always prefer using the dedicated tools for these commands:
    - File search: Use Glob (NOT find or ls)
    - Content search: Use Grep (NOT grep or rg)
    - Read files: Use Read (NOT cat/head/tail)
    - Edit files: Use Edit (NOT sed/awk)
    - Write files: Use Write (NOT echo >/cat <<EOF)
    - Communication: Output text directly (NOT echo/printf)
  - When issuing multiple commands:
    - If the commands are independent and can run in parallel, make multiple Bash tool calls in a single message. For example, if you need to run "git status" and "git diff", send a single message with two Bash tool calls in parallel.
    - If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together (e.g., `git add . && git commit -m "message" && git push`). For instance, if one operation must complete before another starts (like mkdir before cp, Write before Bash for git operations, or git add before git commit), run these operations sequentially instead.
    - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail
    - DO NOT use newlines to separate commands (newlines are ok in quoted strings)
  - Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of `cd`. You may use `cd` if the User explicitly requests it.
    <good-example>
    pytest /foo/bar/tests
    </good-example>
    <bad-example>
    cd /foo/bar && pytest tests
    </bad-example>"#
        ))
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The command to execute"
                },
                "timeout_ms": {
                    "type": "number",
                    "description": "Optional timeout in milliseconds (default 120000, max 600000)"
                },
                "description": {
                    "type": "string",
                    "description": "Clear, concise description of what this command does in 5-10 words, in active voice. Examples:\nInput: ls\nOutput: List files in current directory\n\nInput: git status\nOutput: Show working tree status\n\nInput: npm install\nOutput: Install package dependencies\n\nInput: mkdir foo\nOutput: Create directory 'foo'"
                }
            },
            "required": ["command"],
            "additionalProperties": false
        })
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        false
    }

    fn needs_permissions(&self, _input: Option<&Value>) -> bool {
        true
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        let command = input.get("command").and_then(|v| v.as_str());

        if let Some(cmd) = command {
            let parts: Vec<&str> = cmd.split_whitespace().collect();
            if let Some(base_cmd) = parts.first() {
                // Check if command is banned
                if BANNED_COMMANDS.contains(&base_cmd.to_lowercase().as_str()) {
                    return ValidationResult {
                        result: false,
                        message: Some(format!(
                            "Command '{}' is not allowed for security reasons",
                            base_cmd
                        )),
                        error_code: Some(403),
                        meta: None,
                    };
                }
            }
        } else {
            return ValidationResult {
                result: false,
                message: Some("command is required".to_string()),
                error_code: Some(400),
                meta: None,
            };
        }

        ValidationResult {
            result: true,
            message: None,
            error_code: None,
            meta: None,
        }
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        if let Some(command) = input.get("command").and_then(|v| v.as_str()) {
            // Clean up any command that uses the quoted HEREDOC pattern
            if command.contains("\"$(cat <<'EOF'") {
                // Simple regex-like parsing for HEREDOC
                if let Some(start) = command.find("\"$(cat <<'EOF'\n") {
                    if let Some(end) = command.find("\nEOF\n)") {
                        let prefix = &command[..start];
                        let content_start = start + "\"$(cat <<'EOF'\n".len();
                        let content = &command[content_start..end];
                        return format!("{} \"{}\"", prefix.trim(), content.trim());
                    }
                }
            }
            command.to_string()
        } else {
            "Executing command".to_string()
        }
    }

    async fn call_impl(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> BitFunResult<Vec<ToolResult>> {
        Err(BitFunError::tool(
            "Bash tool call_impl should not be called".to_string(),
        ))
    }

    async fn call(&self, input: &Value, context: &ToolUseContext) -> BitFunResult<Vec<ToolResult>> {
        let start_time = Instant::now();

        // Get command parameter
        let command_str = input
            .get("command")
            .and_then(|v| v.as_str())
            .ok_or_else(|| BitFunError::tool("command is required".to_string()))?;

        const DEFAULT_TIMEOUT_MS: u64 = 120_000;
        const MAX_TIMEOUT_MS: u64 = 600_000;
        let timeout_ms = Some(
            input
                .get("timeout_ms")
                .and_then(|v| v.as_u64())
                .unwrap_or(DEFAULT_TIMEOUT_MS)
                .min(MAX_TIMEOUT_MS),
        );

        // Get session_id (for binding terminal session)
        let chat_session_id = context
            .session_id
            .as_ref()
            .ok_or_else(|| BitFunError::tool("session_id is required for Bash tool".to_string()))?;

        // Get tool call ID (for sending progress events)
        let tool_use_id = context
            .tool_call_id
            .clone()
            .unwrap_or_else(|| format!("bash_{}", uuid::Uuid::new_v4()));
        let tool_name = self.name().to_string();

        debug!(
            "Bash tool executing command: {}, session_id: {}, tool_id: {}",
            command_str, chat_session_id, tool_use_id
        );

        // 1. Get Terminal API
        let terminal_api = TerminalApi::from_singleton()
            .map_err(|e| BitFunError::tool(format!("Terminal not initialized: {}", e)))?;

        // 2. Resolve shell type (falls back to system default if configured shell doesn't support integration)
        let shell_type = Self::resolve_shell().await.shell_type;

        // 3. Get or create terminal session
        let binding = terminal_api.session_manager().binding();
        let workspace_path = get_workspace_path().map(|p| p.to_string_lossy().to_string());

        let terminal_session_id = binding
            .get_or_create(
                chat_session_id,
                TerminalBindingOptions {
                    working_directory: workspace_path.clone(),
                    session_id: Some(chat_session_id.to_string()),
                    session_name: Some(format!(
                        "Chat-{}",
                        &chat_session_id[..8.min(chat_session_id.len())]
                    )),
                    shell_type,
                    env: Some({
                        let mut env = std::collections::HashMap::new();
                        env.insert(
                            "BITFUN_NONINTERACTIVE".to_string(),
                            "1".to_string(),
                        );
                        env
                    }),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| BitFunError::tool(format!("Failed to create Terminal session: {}", e)))?;

        // Get actual working directory
        let working_directory = terminal_api
            .get_session(&terminal_session_id)
            .await
            .map(|s| s.cwd)
            .unwrap_or_default();

        debug!(
            "Bash tool using terminal session: {} (bound to chat: {})",
            terminal_session_id, chat_session_id
        );

        // 4. Create streaming execution request
        let request = ExecuteCommandRequest {
            session_id: terminal_session_id.clone(),
            command: command_str.to_string(),
            timeout_ms,
            prevent_history: Some(true),
        };

        // 5. Execute command and handle streaming output
        let mut stream = terminal_api.execute_command_stream(request);
        let mut accumulated_output = String::new();
        let mut final_exit_code: Option<i32> = None;
        let mut was_interrupted = false;

        // Get event system for sending progress
        let event_system = get_global_event_system();

        while let Some(event) = stream.next().await {
            // Check cancellation request
            if let Some(token) = &context.cancellation_token {
                if token.is_cancelled() && !was_interrupted {
                    // Only send signal on first cancellation detection
                    debug!("Bash tool received cancellation request, sending interrupt signal, tool_id: {}", tool_use_id);
                    was_interrupted = true;

                    // Send interrupt signal to PTY
                    let _ = terminal_api
                        .signal(SignalRequest {
                            session_id: terminal_session_id.clone(),
                            signal: "SIGINT".to_string(),
                        })
                        .await;

                    // Set exit code and exit directly
                    // Unix/Linux: 130 (128 + SIGINT=2)
                    // Windows: -1073741510 (STATUS_CONTROL_C_EXIT)
                    #[cfg(windows)]
                    {
                        final_exit_code = Some(-1073741510);
                    }
                    #[cfg(not(windows))]
                    {
                        final_exit_code = Some(130);
                    }
                    break;
                }
            }

            match event {
                CommandStreamEvent::Started { command_id } => {
                    debug!("Bash command started execution, command_id: {}", command_id);
                }
                CommandStreamEvent::Output { data } => {
                    accumulated_output.push_str(&data);

                    // Send progress event to frontend
                    let progress_event = ToolExecutionProgress(ToolExecutionProgressInfo {
                        tool_use_id: tool_use_id.clone(),
                        tool_name: tool_name.clone(),
                        progress_message: data,
                        percentage: None,
                        timestamp: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs(),
                    });

                    let event_system_clone = event_system.clone();
                    tokio::spawn(async move {
                        let _ = event_system_clone.emit(progress_event).await;
                    });
                }
                CommandStreamEvent::Completed {
                    exit_code,
                    total_output,
                } => {
                    debug!(
                        "Bash command completed, exit_code: {:?}, tool_id: {}",
                        exit_code, tool_use_id
                    );
                    final_exit_code = exit_code;

                    // Even if was_interrupted is false (e.g., user pressed Ctrl+C directly in terminal), should mark as interrupted
                    if matches!(exit_code, Some(130) | Some(-1073741510)) {
                        was_interrupted = true;
                    }

                    // Use complete output (may be more complete than accumulated)
                    if !total_output.is_empty() {
                        accumulated_output = total_output;
                    }
                    break;
                }
                CommandStreamEvent::Error { message } => {
                    error!(
                        "Bash command execution error: {}, tool_id: {}",
                        message, tool_use_id
                    );
                    return Err(BitFunError::tool(format!(
                        "Command execution error: {}",
                        message
                    )));
                }
            }
        }

        // 5. Build result
        let execution_time_ms = start_time.elapsed().as_millis() as u64;

        let result_data = json!({
            "success": final_exit_code.unwrap_or(-1) == 0,
            "command": command_str,
            "output": accumulated_output,
            "exit_code": final_exit_code,
            "interrupted": was_interrupted,
            "working_directory": working_directory,
            "execution_time_ms": execution_time_ms,
            "terminal_session_id": terminal_session_id,
        });

        // Generate result for AI
        let result_for_assistant = self.render_result(
            &accumulated_output,
            was_interrupted,
            final_exit_code.unwrap_or(-1),
        );

        Ok(vec![ToolResult::Result {
            data: result_data,
            result_for_assistant: Some(result_for_assistant),
        }])
    }
}
