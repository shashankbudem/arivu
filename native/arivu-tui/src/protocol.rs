// Portions of this TUI's protocol-driven pager structure are adapted from
// xai-org/grok-build (Apache-2.0). See ../NOTICE.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
pub struct CommandSpec {
    pub command: String,
    pub usage: String,
    pub title: String,
    pub description: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub takes_args: bool,
    #[serde(default)]
    pub args_required: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TranscriptEntry {
    pub kind: EntryKind,
    pub text: String,
    #[serde(default)]
    pub time: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    User,
    Assistant,
    System,
    Error,
    Command,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ActivityItem {
    pub id: String,
    pub phase: ActivityPhase,
    pub name: String,
    #[serde(default)]
    pub detail: String,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ActivityPhase {
    Running,
    Completed,
    Failed,
    System,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ShellOutputStream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Deserialize)]
pub struct InitData {
    pub project_name: String,
    pub cwd: String,
    pub root: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub dirty: bool,
    pub model: String,
    pub trust: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub context_used: Option<u64>,
    #[serde(default)]
    pub context_total: Option<u64>,
    #[serde(default)]
    pub transcript: Vec<TranscriptEntry>,
    #[serde(default)]
    pub activity: Vec<ActivityItem>,
    #[serde(default)]
    pub commands: Vec<CommandSpec>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UsageUpdate {
    #[serde(default)]
    pub prompt_tokens: Option<u64>,
    #[serde(default)]
    pub completion_tokens: Option<u64>,
    #[serde(default)]
    pub total_tokens: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SessionChoice {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModelChoice {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerEvent {
    Init {
        data: Box<InitData>,
    },
    Reset {
        data: Box<InitData>,
    },
    Commit {
        entry: TranscriptEntry,
    },
    RunStarted {
        #[serde(default = "default_working_status")]
        status: String,
    },
    AssistantDelta {
        delta: String,
    },
    ShellStarted {
        command: String,
    },
    ShellOutput {
        stream: ShellOutputStream,
        delta: String,
    },
    ShellCompleted {
        command: String,
        #[serde(default)]
        output: String,
        #[serde(default)]
        exit_code: Option<i32>,
        #[serde(default)]
        signal: Option<String>,
        elapsed_ms: u64,
        #[serde(default)]
        stopped: bool,
        #[serde(default)]
        output_truncated: bool,
    },
    ShellFailed {
        command: String,
        message: String,
        elapsed_ms: u64,
    },
    Activity {
        item: ActivityItem,
    },
    RunCompleted {
        #[serde(default)]
        output: String,
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        usage: Option<UsageUpdate>,
    },
    RunStopped {
        #[serde(default = "default_stopped_message")]
        message: String,
    },
    RunFailed {
        message: String,
    },
    Status {
        message: String,
        #[serde(default)]
        busy: Option<bool>,
        #[serde(default)]
        queue_len: Option<usize>,
        #[serde(default)]
        context_used: Option<u64>,
    },
    Approval {
        id: String,
        #[serde(default = "default_approval_title")]
        title: String,
        message: String,
        #[serde(default)]
        risky: bool,
    },
    Modal {
        title: String,
        body: String,
    },
    SessionPicker {
        #[serde(default)]
        title: Option<String>,
        sessions: Vec<SessionChoice>,
    },
    ModelPicker {
        #[serde(default)]
        title: Option<String>,
        current_model: String,
        #[serde(default)]
        endpoint_label: String,
        models: Vec<ModelChoice>,
        #[serde(default)]
        notice: String,
    },
    ToggleActivity,
    Clear,
    Quit,
}

fn default_working_status() -> String {
    "Working".to_owned()
}

fn default_stopped_message() -> String {
    "Run stopped.".to_owned()
}

fn default_approval_title() -> String {
    "Approval required".to_owned()
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientEvent {
    Hello { token: String },
    Submit { value: String },
    Stop,
    Quit,
    ApprovalResponse { id: String, approved: bool },
    ResumeSession { id: String },
    SelectModel { id: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_picker_and_selection_round_trip_through_ndjson() {
        let event: ServerEvent = serde_json::from_str(
            r#"{"type":"model_picker","current_model":"current","endpoint_label":"https://provider.test/v1","models":[{"id":"next","label":"Next"}],"notice":""}"#,
        )
        .expect("model picker event");
        match event {
            ServerEvent::ModelPicker {
                current_model,
                models,
                ..
            } => {
                assert_eq!(current_model, "current");
                assert_eq!(models[0].id, "next");
            }
            _ => panic!("expected a model picker"),
        }
        let encoded = serde_json::to_string(&ClientEvent::SelectModel {
            id: "next".to_owned(),
        })
        .expect("selection serializes");
        assert_eq!(encoded, r#"{"type":"select_model","id":"next"}"#);
    }

    #[test]
    fn shell_lifecycle_round_trips_through_ndjson() {
        let event: ServerEvent = serde_json::from_str(
            r#"{"type":"shell_completed","command":"printf ok","output":"stdout:\nok","exit_code":0,"elapsed_ms":12,"stopped":false,"output_truncated":false}"#,
        )
        .expect("shell completion event");
        match event {
            ServerEvent::ShellCompleted {
                command,
                exit_code,
                elapsed_ms,
                ..
            } => {
                assert_eq!(command, "printf ok");
                assert_eq!(exit_code, Some(0));
                assert_eq!(elapsed_ms, 12);
            }
            _ => panic!("expected a shell completion"),
        }
        let stream: ServerEvent =
            serde_json::from_str(r#"{"type":"shell_output","stream":"stderr","delta":"warn"}"#)
                .expect("shell stream event");
        assert!(matches!(
            stream,
            ServerEvent::ShellOutput {
                stream: ShellOutputStream::Stderr,
                ..
            }
        ));
    }
}
