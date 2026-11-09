use std::sync::OnceLock;

use jsonschema::error::ValidationErrorKind;
use serde_json::{Map, Value};

use crate::error::Issue;

const MAX_ISSUES: usize = 500;

fn validator() -> &'static jsonschema::Validator {
    static VALIDATOR: OnceLock<jsonschema::Validator> = OnceLock::new();
    VALIDATOR.get_or_init(|| {
        let schema: Value = serde_json::from_str(include_str!("../../schema/gantt.schema.json"))
            .expect("embedded schema is valid JSON");
        jsonschema::options()
            .with_draft(jsonschema::Draft::Draft202012)
            .should_validate_formats(true)
            .build(&schema)
            .expect("embedded schema compiles")
    })
}

fn classify(kind: &ValidationErrorKind) -> (&'static str, Map<String, Value>) {
    let mut params = Map::new();
    let code = match kind {
        ValidationErrorKind::Required { property } => {
            params.insert("property".into(), property.clone());
            "required"
        }
        ValidationErrorKind::Type { kind } => {
            params.insert(
                "expected".into(),
                Value::String(format!("{kind:?}").to_lowercase()),
            );
            "type"
        }
        ValidationErrorKind::Pattern { .. } => "pattern",
        ValidationErrorKind::Format { format } => {
            params.insert("format".into(), Value::String(format.clone()));
            "format"
        }
        ValidationErrorKind::Enum { .. } => "enum",
        ValidationErrorKind::Constant { expected_value } => {
            params.insert("expected".into(), expected_value.clone());
            "const"
        }
        ValidationErrorKind::Minimum { limit } => {
            params.insert("limit".into(), limit.clone());
            "minimum"
        }
        ValidationErrorKind::Maximum { limit } => {
            params.insert("limit".into(), limit.clone());
            "maximum"
        }
        ValidationErrorKind::UniqueItems => "uniqueItems",
        ValidationErrorKind::OneOfNotValid { .. }
        | ValidationErrorKind::OneOfMultipleValid { .. } => "oneOf",
        _ => "other",
    };
    (code, params)
}

/// Validates against the embedded schema. Empty result means valid.
pub fn validate(instance: &Value) -> Vec<Issue> {
    let mut issues: Vec<Issue> = validator()
        .iter_errors(instance)
        .map(|e| {
            let raw = e.instance_path().to_string();
            let (code, params) = classify(e.kind());
            Issue {
                path: if raw.is_empty() { "/".to_string() } else { raw },
                code: code.to_string(),
                message: e.to_string(),
                params,
            }
        })
        .collect();
    issues.sort_by(|a, b| a.path.cmp(&b.path).then_with(|| a.code.cmp(&b.code)));
    issues.dedup_by(|b, a| a.path == b.path && a.code == b.code);
    issues.truncate(MAX_ISSUES);
    issues
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Value {
        serde_json::from_str(include_str!("../tests/fixtures/sample.json")).unwrap()
    }

    fn codes(issues: &[Issue]) -> Vec<(String, String)> {
        issues
            .iter()
            .map(|i| (i.path.clone(), i.code.clone()))
            .collect()
    }

    #[test]
    fn sample_is_valid() {
        assert!(validate(&sample()).is_empty());
    }

    #[test]
    fn bad_date_reports_pattern_and_format() {
        let mut v = sample();
        v["tasks"][0]["start"] = json!("2023-13-01");
        let issues = validate(&v);
        let c = codes(&issues);
        assert!(
            c.contains(&("/tasks/0/start".into(), "pattern".into())),
            "{c:?}"
        );
        assert!(
            c.contains(&("/tasks/0/start".into(), "format".into())),
            "{c:?}"
        );
    }

    #[test]
    fn version_2_reports_const() {
        let mut v = sample();
        v["version"] = json!(2);
        let issues = validate(&v);
        assert_eq!(
            codes(&issues),
            vec![("/version".to_string(), "const".to_string())]
        );
        assert_eq!(issues[0].params["expected"], json!(1));
    }

    #[test]
    fn progress_101_reports_maximum() {
        let mut v = sample();
        let idx = v["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .position(|t| t.get("progress").is_some())
            .unwrap();
        v["tasks"][idx]["progress"] = json!(101);
        let issues = validate(&v);
        assert_eq!(
            codes(&issues),
            vec![(format!("/tasks/{idx}/progress"), "maximum".to_string())]
        );
    }

    #[test]
    fn missing_tasks_reports_required_at_root() {
        let mut v = sample();
        v.as_object_mut().unwrap().remove("tasks");
        let issues = validate(&v);
        assert_eq!(
            codes(&issues),
            vec![("/".to_string(), "required".to_string())]
        );
        assert_eq!(issues[0].params["property"], json!("tasks"));
    }

    #[test]
    fn unknown_field_is_valid() {
        let mut v = sample();
        v["tasks"][0]["custom"] = json!(1);
        assert!(validate(&v).is_empty());
    }
}
