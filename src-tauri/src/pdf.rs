//! SVG -> PDF conversion (A3 landscape, Noto Sans JP embedded, horizontal splitting). See 04 section 4.

use pdf_writer::{Content, Finish, Name, Pdf, Rect, Ref, TextStr};
use serde::Deserialize;
use svg2pdf::{ConversionOptions, usvg};

use crate::error::AppError;

static REGULAR: &[u8] = include_bytes!("../resources/fonts/NotoSansJP-Regular.otf");
static BOLD: &[u8] = include_bytes!("../resources/fonts/NotoSansJP-Bold.otf");

const PAGE_W: f64 = 1190.55;
const PAGE_H: f64 = 841.89;
const MARGIN: f64 = 28.35;
/// pt per SVG px at 96 dpi.
const BASE_SCALE: f64 = 0.75;
/// Smallest scale (pt/px) before the figure is split horizontally.
const MIN_SCALE: f64 = 0.45;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfOptions {
    pub page_size: String,
    pub orientation: String,
    pub frozen_width: f64,
    pub default_file_name: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PageLayout {
    pub pages: usize,
    /// pt per px.
    pub scale: f64,
    /// Width (px) of the left part repeated on every page (0 when not repeated).
    pub frozen: f64,
    /// Timeline width (px) shown per page (equals the whole figure for a single page).
    pub slice: f64,
}

/// Pure page layout (04 section 4.3). `w`, `h` and `frozen` are in SVG px.
pub fn layout_pages(w: f64, h: f64, frozen: f64) -> PageLayout {
    let aw = PAGE_W - 2.0 * MARGIN;
    let ah = PAGE_H - 2.0 * MARGIN;
    let s_fit = BASE_SCALE.min(aw / w).min(ah / h);
    if s_fit >= MIN_SCALE {
        return PageLayout {
            pages: 1,
            scale: s_fit,
            frozen: 0.0,
            slice: w,
        };
    }
    let s = BASE_SCALE.min(ah / h).min(MIN_SCALE);
    let f = if frozen * s > aw / 2.0 || frozen < 0.0 {
        0.0
    } else {
        frozen
    };
    let slice = aw / s - f;
    let pages = ((w - f) / slice).ceil().max(1.0) as usize;
    PageLayout {
        pages,
        scale: s,
        frozen: f,
        slice,
    }
}

fn usvg_options() -> usvg::Options<'static> {
    let mut opt = usvg::Options {
        font_family: "Noto Sans JP".to_string(),
        ..Default::default()
    };
    let db = opt.fontdb_mut();
    db.load_font_data(REGULAR.to_vec());
    db.load_font_data(BOLD.to_vec());
    db.set_sans_serif_family("Noto Sans JP");
    opt
}

fn pdf_err(message: impl ToString) -> AppError {
    AppError::Pdf {
        message: message.to_string(),
    }
}

/// Converts an SVG document into PDF bytes.
pub fn svg_to_pdf(svg: &str, options: &PdfOptions) -> Result<Vec<u8>, AppError> {
    if options.page_size != "A3" || options.orientation != "landscape" {
        return Err(pdf_err("unsupported page"));
    }
    let tree = usvg::Tree::from_str(svg, &usvg_options()).map_err(pdf_err)?;
    let size = tree.size();
    let (w, h) = (size.width() as f64, size.height() as f64);
    if !(w > 0.0 && h > 0.0) {
        return Err(pdf_err("empty svg"));
    }
    let (svg_chunk, svg_ref) =
        svg2pdf::to_chunk(&tree, ConversionOptions::default()).map_err(pdf_err)?;

    let mut alloc = Ref::new(1);
    let catalog_id = alloc.bump();
    let tree_id = alloc.bump();
    let info_id = alloc.bump();
    let mut map = std::collections::HashMap::new();
    let svg_chunk = svg_chunk.renumber(|old| *map.entry(old).or_insert_with(|| alloc.bump()));
    let svg_id = *map
        .get(&svg_ref)
        .ok_or_else(|| pdf_err("svg xobject missing"))?;

    let lay = layout_pages(w, h, options.frozen_width);
    let page_ids: Vec<(Ref, Ref)> = (0..lay.pages)
        .map(|_| (alloc.bump(), alloc.bump()))
        .collect();
    let name = Name(b"S1");

    let mut pdf = Pdf::new();
    pdf.catalog(catalog_id).pages(tree_id);
    pdf.pages(tree_id)
        .kids(page_ids.iter().map(|p| p.0))
        .count(lay.pages as i32);
    {
        let mut info = pdf.document_info(info_id);
        info.title(TextStr(&options.title));
        info.creator(TextStr("json-gantt"));
    }

    let s = lay.scale;
    let ty = PAGE_H - MARGIN - h * s;
    for (i, (page_id, content_id)) in page_ids.iter().enumerate() {
        let mut page = pdf.page(*page_id);
        page.media_box(Rect::new(0.0, 0.0, PAGE_W as f32, PAGE_H as f32));
        page.parent(tree_id);
        page.contents(*content_id);
        page.resources().x_objects().pair(name, svg_id);
        page.finish();

        let mut c = Content::new();
        if lay.pages == 1 {
            c.save_state();
            c.transform([
                (w * s) as f32,
                0.0,
                0.0,
                (h * s) as f32,
                MARGIN as f32,
                ty as f32,
            ]);
            c.x_object(name);
            c.restore_state();
        } else {
            if lay.frozen > 0.0 {
                c.save_state();
                c.rect(
                    MARGIN as f32,
                    ty as f32,
                    (lay.frozen * s) as f32,
                    (h * s) as f32,
                );
                c.clip_nonzero();
                c.end_path();
                c.transform([
                    (w * s) as f32,
                    0.0,
                    0.0,
                    (h * s) as f32,
                    MARGIN as f32,
                    ty as f32,
                ]);
                c.x_object(name);
                c.restore_state();
            }
            let x0 = lay.frozen + i as f64 * lay.slice;
            let wi = lay.slice.min(w - x0);
            let left = MARGIN + lay.frozen * s;
            c.save_state();
            c.rect(left as f32, ty as f32, (wi * s) as f32, (h * s) as f32);
            c.clip_nonzero();
            c.end_path();
            c.transform([
                (w * s) as f32,
                0.0,
                0.0,
                (h * s) as f32,
                (left - x0 * s) as f32,
                ty as f32,
            ]);
            c.x_object(name);
            c.restore_state();
        }
        pdf.stream(*content_id, &c.finish());
    }
    pdf.extend(&svg_chunk);
    Ok(pdf.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> PdfOptions {
        PdfOptions {
            page_size: "A3".into(),
            orientation: "landscape".into(),
            frozen_width: 330.0,
            default_file_name: "x.pdf".into(),
            title: "テスト".into(),
        }
    }

    fn contains(hay: &[u8], needle: &[u8]) -> bool {
        hay.windows(needle.len()).any(|w| w == needle)
    }

    fn count_pages(pdf: &[u8]) -> usize {
        let key = b"/Type /Page\n";
        pdf.windows(key.len()).filter(|w| *w == key).count()
    }

    #[test]
    fn layout_single_page() {
        let l = layout_pages(1200.0, 800.0, 330.0);
        assert_eq!(l.pages, 1);
        assert!((l.scale - 0.75).abs() < 1e-9);
    }

    #[test]
    fn layout_split() {
        let l = layout_pages(6000.0, 800.0, 330.0);
        assert_eq!(l.pages, 3);
        assert!((l.scale - 0.45).abs() < 1e-9);
        assert!((l.slice - 2189.67).abs() < 0.01);
        assert_eq!(l.frozen, 330.0);
    }

    #[test]
    fn pdf_smoke() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100" viewBox="0 0 400 100" font-family="Noto Sans JP">
<rect width="400" height="100" fill="#FFFFFF"/><text x="10" y="50" font-size="20" fill="#000000">テスト</text></svg>"##;
        let bytes = svg_to_pdf(svg, &opts()).unwrap();
        assert!(bytes.starts_with(b"%PDF-"));
        // CFF (OpenType) fonts are embedded as /FontFile3, TrueType as /FontFile2.
        assert!(contains(&bytes, b"/FontFile2") || contains(&bytes, b"/FontFile3"));
        assert_eq!(count_pages(&bytes), 1);
    }

    #[test]
    fn rejects_unsupported_page() {
        let mut o = opts();
        o.page_size = "A4".into();
        assert!(matches!(
            svg_to_pdf("<svg/>", &o),
            Err(AppError::Pdf { .. })
        ));
    }

    /// Manual visual check: `WP9_SAMPLE_SVG=in.svg WP9_SAMPLE_PDF=out.pdf cargo test wp9_sample`.
    #[test]
    fn wp9_sample() {
        let (Ok(i), Ok(o)) = (
            std::env::var("WP9_SAMPLE_SVG"),
            std::env::var("WP9_SAMPLE_PDF"),
        ) else {
            return;
        };
        let svg = std::fs::read_to_string(i).unwrap();
        let bytes = svg_to_pdf(&svg, &opts()).unwrap();
        println!("pages = {}", count_pages(&bytes));
        std::fs::write(o, bytes).unwrap();
    }
}
