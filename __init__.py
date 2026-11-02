import json
import math

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageOps
from typing_extensions import override

import comfy.utils
import folder_paths
from comfy_api.latest import ComfyExtension, io, ui

WEB_DIRECTORY = "./web"

# Panel rects are normalized to the page (0..1). Page width/height only set the aspect ratio; margin and gutter are in the same units.
DEFAULT_LAYOUT = {
    "page": {"name": "Manga B5", "width": 182, "height": 257},
    "margin": 10,
    "gutter": 4,
    "direction": "rtl",
    "preset": None,
    "panels": [],
}


# Page editor state of Anima Komikku Page Compose. Framing is per panel (zoom over the cover scale, dx/dy in fractions of the panel box);
# overlays and the lettering layer are files the editor uploads to the input folder.
DEFAULT_COMPOSITION = {"panels": [], "overlays": [], "texts": [], "lettering": None}


@io.comfytype(io_type="ANIMA_KOMIKKU_PAGE_LAYOUT")
class PageLayout(io.ComfyTypeIO):
    Type = str

    class Input(io.WidgetInput):
        pass


@io.comfytype(io_type="ANIMA_KOMIKKU_PAGE_COMPOSITION")
class PageComposition(io.ComfyTypeI):
    Type = str

    class Input(io.WidgetInput):
        pass


def _assist_clip_input():
    # Only the page editors read this link (they run the loader wired here through TextGenerate); it is lazy and never requested,
    # so the text model is not loaded when the workflow runs.
    return io.Clip.Input("assist_clip", optional=True, lazy=True,
                         tooltip="Text model for the editor's prompt and dialogue assist. Wire a CLIP Loader whose model can generate text, e.g. the MOSS-Image Qwen3.5-9B encoder.")


def _panel_size(aspect: float, megapixels: float) -> tuple[int, int]:
    w = math.sqrt(megapixels * 1024 * 1024 * aspect)
    return max(16, round(w / 16) * 16), max(16, round(w / aspect / 16) * 16)


def _polygon_mask(points, x0, y0, w, h):
    # Drawn at 4x and box-filtered down so slanted edges stay smooth.
    img = Image.new("L", (w * 4, h * 4), 0)
    ImageDraw.Draw(img).polygon([((x - x0) * 4, (y - y0) * 4) for x, y in points], fill=255)
    return torch.from_numpy(np.asarray(img.resize((w, h), Image.BOX), dtype=np.float32) / 255.0)


def _framed(image, w, h, framing):
    # Same placement as the page editor: cover scale times zoom, centered, shifted by dx/dy; uncovered area stays white.
    ih, iw = image.shape[0], image.shape[1]
    s = max(w / iw, h / ih) * framing.get("zoom", 1.0)
    left = (w - iw * s) / 2 + framing.get("dx", 0.0) * w
    top = (h - ih * s) / 2 + framing.get("dy", 0.0) * h
    out = torch.ones((h, w, 3), dtype=image.dtype, device=image.device)
    x0, y0, x1, y1 = max(0, round(left)), max(0, round(top)), min(w, round(left + iw * s)), min(h, round(top + ih * s))
    if x1 <= x0 or y1 <= y0:
        return out
    sx0, sy0 = int((x0 - left) / s), int((y0 - top) / s)
    sx1, sy1 = min(iw, max(sx0 + 1, math.ceil((x1 - left) / s))), min(ih, max(sy0 + 1, math.ceil((y1 - top) / s)))
    crop = image[sy0:sy1, sx0:sx1].movedim(-1, 0)[None]
    out[y0:y1, x0:x1] = comfy.utils.common_upscale(crop, x1 - x0, y1 - y0, "area" if s < 1 else "bilinear", "disabled")[0].movedim(0, -1)
    return out


def _load_rgba(name):
    img = ImageOps.exif_transpose(Image.open(folder_paths.get_annotated_filepath(name))).convert("RGBA")
    return torch.from_numpy(np.asarray(img, dtype=np.float32) / 255.0)


def _paste_rgba(target, rgba, x, y, w, h, opacity):
    # Alpha-composites rgba, scaled to w x h, onto target at (x, y); the part outside target is dropped.
    if w <= 0 or h <= 0:
        return
    if rgba.shape[0] != h or rgba.shape[1] != w:
        rgba = comfy.utils.common_upscale(rgba.movedim(-1, 0)[None], w, h, "bilinear", "disabled")[0].movedim(0, -1)
    tx0, ty0, tx1, ty1 = max(0, x), max(0, y), min(target.shape[1], x + w), min(target.shape[0], y + h)
    if tx1 <= tx0 or ty1 <= ty0:
        return
    part = rgba[ty0 - y:ty1 - y, tx0 - x:tx1 - x]
    target[ty0:ty1, tx0:tx1] = torch.lerp(target[ty0:ty1, tx0:tx1], part[..., :3], part[..., 3:] * opacity)


class AnimaKomikkuPageLayout(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="AnimaKomikkuPageLayout",
            display_name="Anima Komikku Page & Panels",
            category="Anima-Komikku",
            description="Page layout editor with one Anima prompt per manga panel. Outputs one prompt and one panel size per panel, in panel number order, "
                        "so a single sampler chain renders every panel; the character reference and artist style are applied to the model in the workflow.",
            inputs=[
                PageLayout.Input("layout", socketless=True, default=json.dumps(DEFAULT_LAYOUT),
                                 tooltip="Page layout: panel shapes, their order and one prompt per panel."),
                io.String.Input("quality", multiline=True, default="masterpiece, best quality, score_7, safe",
                                tooltip="Tags written first in every panel prompt."),
                io.String.Input("style", multiline=True, default="",
                                tooltip="Artist tags for the whole page, written after the quality tags (e.g. @artist1, @artist2). "
                                        "Leave empty when Anima Artist Mixer sets the style."),
                io.Float.Input("panel_megapixels", default=1.0, min=0.1, max=4.0, step=0.05, tooltip="Pixel area used to size each panel from its aspect ratio on the page."),
                _assist_clip_input(),
            ],
            outputs=[
                io.String.Output(display_name="prompt", is_output_list=True),
                io.Int.Output(display_name="panel_width", is_output_list=True),
                io.Int.Output(display_name="panel_height", is_output_list=True),
                PageLayout.Output(display_name="layout"),
            ],
        )

    @classmethod
    def check_lazy_status(cls, **kwargs):
        return []

    @classmethod
    def execute(cls, layout, quality, style, panel_megapixels, assist_clip=None) -> io.NodeOutput:
        layout = json.loads(layout)
        panels = layout["panels"]
        if not panels:
            raise ValueError("The page layout has no panels. Open the page editor on Anima Komikku Page & Panels and design the page.")
        head = [t.strip().rstrip(",") for t in (quality, style) if t.strip()]
        prompts = [", ".join(head + [p["prompt"].strip()]) for p in panels]
        page_w, page_h = layout["page"]["width"], layout["page"]["height"]
        sizes = [_panel_size(p["w"] * page_w / (p["h"] * page_h), panel_megapixels) for p in panels]
        return io.NodeOutput(prompts, [w for w, _ in sizes], [h for _, h in sizes], json.dumps(layout))


class AnimaKomikkuPageCompose(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="AnimaKomikkuPageCompose",
            display_name="Anima Komikku Page Compose",
            category="Anima-Komikku",
            description="Composes the page from Anima Komikku Page & Panels in panel number order. The page editor frames each panel image, adds imported RGB/RGBA images over the panels, and letters the page with speech bubbles and text.",
            is_input_list=True,
            inputs=[
                io.Image.Input("panels", tooltip="One image per panel, in panel order. Missing panels stay blank, extra images are ignored."),
                PageLayout.Input("layout", force_input=True),
                io.Int.Input("page_width", default=2480, min=256, max=16384, step=16, tooltip="Page width in pixels; the height follows the page format."),
                io.Int.Input("border", default=6, min=0, max=64, tooltip="Black panel border in pixels, drawn inside each panel."),
                PageComposition.Input("composition", socketless=True, default=json.dumps(DEFAULT_COMPOSITION),
                                      tooltip="Edited in the page editor: image framing per panel, imported images and lettering."),
                _assist_clip_input(),
            ],
            outputs=[io.Image.Output(display_name="page")],
        )

    @classmethod
    def check_lazy_status(cls, **kwargs):
        return []

    @classmethod
    def execute(cls, panels, layout, page_width, border, composition, assist_clip=None) -> io.NodeOutput:
        layout, comp = json.loads(layout[0]), json.loads(composition[0])
        page_width, border = page_width[0], border[0]
        page_height = round(page_width * layout["page"]["height"] / layout["page"]["width"])
        images = [img for batch in panels for img in batch]
        page = torch.ones((page_height, page_width, 3), dtype=images[0].dtype, device=images[0].device)
        for i, (panel, image) in enumerate(zip(layout["panels"], images)):
            x0, y0 = round(panel["x"] * page_width), round(panel["y"] * page_height)
            x1, y1 = round((panel["x"] + panel["w"]) * page_width), round((panel["y"] + panel["h"]) * page_height)
            w, h = x1 - x0, y1 - y0
            if w <= 0 or h <= 0:
                continue
            framing = comp["panels"][i] if i < len(comp["panels"]) else {}
            content = _framed(image[..., :3], w, h, framing)
            for overlay in comp["overlays"]:
                if overlay["panel"] == i:
                    _paste_rgba(content, _load_rgba(overlay["image"]).to(content), round(overlay["x"] * page_width) - x0, round(overlay["y"] * page_height) - y0,
                                round(overlay["w"] * page_width), round(overlay["h"] * page_height), overlay.get("opacity", 1.0))
            if "polygon" in panel:
                mask = _polygon_mask([(x * page_width, y * page_height) for x, y in panel["polygon"]], x0, y0, w, h).to(page)
            else:
                mask = torch.ones((h, w), dtype=page.dtype, device=page.device)
            inner = mask
            if border:
                inner = 1 - torch.nn.functional.max_pool2d(torch.nn.functional.pad(1 - mask[None, None], (border,) * 4, value=1.0), 2 * border + 1, stride=1)[0, 0]
            page[y0:y1, x0:x1] = torch.lerp(page[y0:y1, x0:x1] * (1 - mask[..., None]), content, inner[..., None])
        if comp.get("lettering"):
            _paste_rgba(page, _load_rgba(comp["lettering"]).to(page), 0, 0, page_width, page_height, 1.0)
        page = page[None]
        previews = [r for img in images for r in ui.ImageSaveHelper.save_images([img[..., :3]], "anima_komikku_panel", io.FolderType.temp, None)]
        return io.NodeOutput(page, ui={"komikku_page": ui.ImageSaveHelper.save_images(page, "anima_komikku_page", io.FolderType.temp, None), "komikku_panels": previews,
                                       "komikku_layout": [json.dumps(layout)]})


class AnimaKomikkuExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [AnimaKomikkuPageLayout, AnimaKomikkuPageCompose]


async def comfy_entrypoint() -> AnimaKomikkuExtension:
    return AnimaKomikkuExtension()
