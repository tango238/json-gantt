use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Debug, Clone, Serialize)]
pub struct Issue {
    pub path: String,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Map::is_empty")]
    pub params: Map<String, Value>,
}

impl Issue {
    pub fn new(
        path: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Issue {
            path: path.into(),
            code: code.into(),
            message: message.into(),
            params: Map::new(),
        }
    }

    pub fn with_param(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.params.insert(key.to_string(), value.into());
        self
    }
}

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AppError {
    #[error("io: {message}")]
    Io {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
    },
    #[error("parse: {message}")]
    ParseError {
        message: String,
        line: usize,
        column: usize,
    },
    #[error("unsupported version {found}")]
    UnsupportedVersion { found: i64, supported: i64 },
    #[error("schema invalid")]
    SchemaInvalid { errors: Vec<Issue> },
    #[error("pdf: {message}")]
    Pdf { message: String },
    #[error("ai: {message}")]
    Ai { message: String },
    #[error("claude not found")]
    AiNotFound { searched: Vec<String> },
    #[error("internal: {message}")]
    Internal { message: String },
}

impl AppError {
    pub fn io(message: impl Into<String>, path: Option<&std::path::Path>) -> Self {
        AppError::Io {
            message: message.into(),
            path: path.map(|p| p.to_string_lossy().into_owned()),
        }
    }

    pub fn internal(message: impl ToString) -> Self {
        AppError::Internal {
            message: message.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_is_screaming_snake_case() {
        let v = |e: AppError| serde_json::to_value(e).unwrap();
        assert_eq!(v(AppError::io("x", None))["kind"], "IO");
        assert!(v(AppError::io("x", None)).get("path").is_none());
        assert_eq!(
            v(AppError::io("x", Some(std::path::Path::new("/a"))))["path"],
            "/a"
        );
        assert_eq!(
            v(AppError::ParseError {
                message: "m".into(),
                line: 1,
                column: 2
            })["kind"],
            "PARSE_ERROR"
        );
        assert_eq!(
            v(AppError::UnsupportedVersion {
                found: 2,
                supported: 1
            }),
            serde_json::json!({"kind": "UNSUPPORTED_VERSION", "found": 2, "supported": 1})
        );
        assert_eq!(
            v(AppError::SchemaInvalid { errors: vec![] })["kind"],
            "SCHEMA_INVALID"
        );
        assert_eq!(
            v(AppError::Pdf {
                message: "m".into()
            })["kind"],
            "PDF"
        );
        assert_eq!(v(AppError::internal("m"))["kind"], "INTERNAL");
        assert_eq!(
            v(AppError::Ai {
                message: "m".into()
            }),
            serde_json::json!({"kind": "AI", "message": "m"})
        );
        assert_eq!(
            v(AppError::AiNotFound {
                searched: vec!["/a".into()]
            }),
            serde_json::json!({"kind": "AI_NOT_FOUND", "searched": ["/a"]})
        );
    }
}
