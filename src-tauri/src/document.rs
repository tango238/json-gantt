//! serde model of the project file. Field order is the output key order;
//! `extra` is always last so unknown keys trail the known ones.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GanttDocument {
    #[serde(rename = "$schema", default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub version: i64,
    pub project: Project,
    #[serde(default)]
    pub resources: Vec<Resource>,
    #[serde(rename = "colorLabels", default)]
    pub color_labels: Vec<ColorLabel>,
    pub tasks: Vec<Task>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<ViewSettings>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar: Option<Calendar>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Calendar {
    pub weekends: Vec<u8>,
    pub holidays: Vec<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Resource {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColorLabel {
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    /// Missing -> None; always written (as null when None).
    #[serde(rename = "parentId", default)]
    pub parent_id: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hours: Option<Number>,
    #[serde(rename = "resourceIds", default)]
    pub resource_ids: Vec<String>,
    #[serde(
        rename = "colorLabelId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub color_label_id: Option<String>,
    #[serde(default)]
    pub dependencies: Vec<Dependency>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dependency {
    #[serde(rename = "predecessorId")]
    pub predecessor_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lag: Option<i64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zoom: Option<String>,
    #[serde(rename = "collapsedTaskIds", default)]
    pub collapsed_task_ids: Vec<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl GanttDocument {
    /// Defensive: parent tasks (ids referenced by any `parentId`, compared
    /// case-insensitively) must not carry derived values.
    pub fn strip_parent_derived(&mut self) {
        let parents: HashSet<String> = self
            .tasks
            .iter()
            .filter_map(|t| t.parent_id.as_ref())
            .map(|p| p.to_lowercase())
            .collect();
        for t in &mut self.tasks {
            if parents.contains(&t.id.to_lowercase()) {
                t.start = None;
                t.end = None;
                t.progress = None;
                t.hours = None;
            }
        }
    }

    /// JSON Pointers of every unknown key, in document order.
    pub fn unknown_field_paths(&self) -> Vec<String> {
        fn collect(out: &mut Vec<String>, base: &str, extra: &Map<String, Value>) {
            for k in extra.keys() {
                out.push(format!(
                    "{base}/{}",
                    k.replace('~', "~0").replace('/', "~1")
                ));
            }
        }
        let mut out = Vec::new();
        collect(&mut out, "", &self.extra);
        collect(&mut out, "/project", &self.project.extra);
        if let Some(c) = &self.project.calendar {
            collect(&mut out, "/project/calendar", &c.extra);
        }
        for (i, r) in self.resources.iter().enumerate() {
            collect(&mut out, &format!("/resources/{i}"), &r.extra);
        }
        for (i, c) in self.color_labels.iter().enumerate() {
            collect(&mut out, &format!("/colorLabels/{i}"), &c.extra);
        }
        for (i, t) in self.tasks.iter().enumerate() {
            collect(&mut out, &format!("/tasks/{i}"), &t.extra);
            for (j, d) in t.dependencies.iter().enumerate() {
                collect(&mut out, &format!("/tasks/{i}/dependencies/{j}"), &d.extra);
            }
        }
        if let Some(v) = &self.view {
            collect(&mut out, "/view", &v.extra);
        }
        out
    }
}

/// JSON numbers like `50.0` are valid integers for the schema but fail serde's
/// integer types. Rewrites such values (zero fractional part) to integers at
/// every integer-typed known field: version, weekends, progress, lag.
pub fn normalize_integers(root: &mut Value) {
    fn fix(v: &mut Value) {
        if let Value::Number(n) = v
            && !n.is_i64()
            && !n.is_u64()
            && let Some(f) = n.as_f64()
            && f.fract() == 0.0
            && f.abs() < 9.0e15
        {
            *v = Value::Number(Number::from(f as i64));
        }
    }
    let Some(obj) = root.as_object_mut() else {
        return;
    };
    if let Some(v) = obj.get_mut("version") {
        fix(v);
    }
    if let Some(Value::Array(ws)) = obj
        .get_mut("project")
        .and_then(|p| p.get_mut("calendar"))
        .and_then(|c| c.get_mut("weekends"))
    {
        ws.iter_mut().for_each(fix);
    }
    if let Some(Value::Array(tasks)) = obj.get_mut("tasks") {
        for t in tasks {
            if let Some(v) = t.get_mut("progress") {
                fix(v);
            }
            if let Some(Value::Array(deps)) = t.get_mut("dependencies") {
                for d in deps {
                    if let Some(v) = d.get_mut("lag") {
                        fix(v);
                    }
                }
            }
        }
    }
}

/// Canonical on-disk form: 2-space indent, LF, trailing newline.
pub fn to_file_string(doc: &GanttDocument) -> Result<String, serde_json::Error> {
    let mut s = serde_json::to_string_pretty(doc)?;
    s.push('\n');
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SAMPLE: &str = include_str!("../tests/fixtures/sample.json");
    const UNKNOWN: &str = include_str!("../tests/fixtures/unknown_fields.json");

    fn roundtrip(s: &str) -> String {
        let doc: GanttDocument = serde_json::from_str(s).unwrap();
        to_file_string(&doc).unwrap()
    }

    #[test]
    fn roundtrip_sample() {
        assert_eq!(roundtrip(SAMPLE), SAMPLE);
    }

    #[test]
    fn roundtrip_unknown_fields() {
        assert_eq!(roundtrip(UNKNOWN), UNKNOWN);
        let doc: GanttDocument = serde_json::from_str(UNKNOWN).unwrap();
        assert_eq!(doc.unknown_field_paths().len(), 8);
    }

    #[test]
    fn key_order() {
        let input = json!({
            "zzz": 1,
            "tasks": [{ "dependencies": [], "name": "T", "x": [1], "id": "a", "parentId": null, "resourceIds": [] }],
            "project": { "extra": true, "name": "P" },
            "version": 1
        })
        .to_string();
        let out: Value = serde_json::from_str(&roundtrip(&input)).unwrap();
        let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        assert_eq!(
            keys(&out),
            [
                "version",
                "project",
                "resources",
                "colorLabels",
                "tasks",
                "zzz"
            ]
        );
        assert_eq!(keys(&out["project"]), ["name", "extra"]);
        assert_eq!(
            keys(&out["tasks"][0]),
            ["id", "parentId", "name", "resourceIds", "dependencies", "x"]
        );
    }

    #[test]
    fn hours_number_repr() {
        let input = r#"{"version":1,"project":{"name":"P"},"tasks":[
            {"id":"a","name":"A","hours":8},{"id":"b","name":"B","hours":7.5}]}"#;
        let out = roundtrip(input);
        assert!(
            out.contains("\"hours\": 8,") || out.contains("\"hours\": 8\n"),
            "{out}"
        );
        assert!(out.contains("\"hours\": 7.5"), "{out}");
        assert!(!out.contains("8.0"));
    }

    #[test]
    fn parent_fields_stripped_on_save() {
        let input = r#"{"version":1,"project":{"name":"P"},"tasks":[
            {"id":"AA","name":"parent","start":"2023-01-01","end":"2023-01-02","progress":10,"hours":3},
            {"id":"b","parentId":"aa","name":"child","start":"2023-01-01","end":"2023-01-02","progress":10}]}"#;
        let mut doc: GanttDocument = serde_json::from_str(input).unwrap();
        doc.strip_parent_derived();
        let out = to_file_string(&doc).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        for k in ["start", "end", "progress", "hours"] {
            assert!(v["tasks"][0].get(k).is_none(), "{k}");
        }
        assert_eq!(v["tasks"][1]["start"], "2023-01-01");
    }

    #[test]
    fn key_order_covers_all_levels() {
        let input = json!({
            "view": { "x": 1, "collapsedTaskIds": [], "zoom": "day" },
            "tasks": [{
                "notes": "n", "dependencies": [{ "d": 1, "lag": 2, "predecessorId": "b" }],
                "colorLabelId": "c", "resourceIds": [], "hours": 1, "progress": 1, "end": "2023-01-01",
                "start": "2023-01-01", "name": "A", "parentId": null, "id": "a"
            }],
            "colorLabels": [{ "z": 1, "color": "#000000", "name": "n", "id": "c" }],
            "resources": [{ "z": 1, "color": "#000000", "name": "n", "id": "r" }],
            "project": { "calendar": { "k": 1, "holidays": [], "weekends": [0] }, "description": "d", "name": "P" },
            "$schema": "s", "version": 1
        })
        .to_string();
        let out: Value = serde_json::from_str(&roundtrip(&input)).unwrap();
        let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
        assert_eq!(
            keys(&out),
            [
                "$schema",
                "version",
                "project",
                "resources",
                "colorLabels",
                "tasks",
                "view"
            ]
        );
        assert_eq!(keys(&out["project"]), ["name", "description", "calendar"]);
        assert_eq!(
            keys(&out["project"]["calendar"]),
            ["weekends", "holidays", "k"]
        );
        assert_eq!(keys(&out["resources"][0]), ["id", "name", "color", "z"]);
        assert_eq!(keys(&out["colorLabels"][0]), ["id", "name", "color", "z"]);
        assert_eq!(
            keys(&out["tasks"][0]),
            [
                "id",
                "parentId",
                "name",
                "start",
                "end",
                "progress",
                "hours",
                "resourceIds",
                "colorLabelId",
                "dependencies",
                "notes"
            ]
        );
        assert_eq!(
            keys(&out["tasks"][0]["dependencies"][0]),
            ["predecessorId", "lag", "d"]
        );
        assert_eq!(keys(&out["view"]), ["zoom", "collapsedTaskIds", "x"]);
    }

    #[test]
    fn parent_id_null_written() {
        let input = r#"{"version":1,"project":{"name":"P"},"tasks":[{"id":"a","name":"A"}]}"#;
        let out = roundtrip(input);
        assert!(out.contains("\"parentId\": null"), "{out}");
    }
}
