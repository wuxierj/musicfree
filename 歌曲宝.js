/**
 * MusicFree 插件：歌曲宝（gequbao.com）
 * 功能：搜索 / 音乐详情 / 播放地址 / 歌词 / 直链导入
 */
const axios = require("axios");
const cheerio = require("cheerio");
const qs = require("qs");

const BASE = "https://www.gequbao.com";
/** 插件直链：上传到静态托管后填这里，应用内即可检查更新；留空表示不检查 */
const SRC_URL = "";
const UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** 手动维护的 cookie，页面种下的 session 是播放接口的必需项 */
let cookieJar = {};

function sleep(ms) {
    return new Promise(function (resolve) {
        setTimeout(resolve, ms);
    });
}

function cookieHeader() {
    const keys = Object.keys(cookieJar);
    if (keys.length === 0) {
        return "";
    }
    return keys
        .map(function (key) {
            return key + "=" + cookieJar[key];
        })
        .join("; ");
}

function rememberCookies(response) {
    const headers = (response && response.headers) || {};
    let raw = headers["set-cookie"] || headers["x-set-cookie"];
    if (!raw) {
        return;
    }
    const list = Array.isArray(raw) ? raw : [raw];
    list.forEach(function (item) {
        String(item)
            .split(",")
            .forEach(function (part) {
                const kv = part.split(";")[0];
                const index = kv.indexOf("=");
                if (index > 0) {
                    const name = kv.slice(0, index).trim();
                    const value = kv.slice(index + 1).trim();
                    if (name && name !== "expires" && name !== "path" && name !== "Max-Age") {
                        cookieJar[name] = value;
                    }
                }
            });
    });
}

function requestHeaders(referer) {
    const headers = {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
        Referer: referer || BASE + "/",
    };
    const cookie = cookieHeader();
    if (cookie) {
        headers.Cookie = cookie;
    }
    return headers;
}

function apiHeaders(id) {
    return {
        "User-Agent": UA,
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Origin: BASE,
        Referer: BASE + "/music/" + id,
    };
}

/** 解析歌曲页的 window.appData */
function parseAppData(html) {
    const match = String(html).match(/window\.appData\s*=\s*JSON\.parse\(([\s\S]*?)\);/);
    if (!match) {
        return null;
    }
    try {
        // 参数是一个 JS 字符串字面量，直接求值可正确还原其中的转义
        return JSON.parse(eval(match[1]));
    } catch (e) {
        return null;
    }
}

function parseDuration(text) {
    const parts = String(text || "").trim().split(":");
    if (parts.length < 2) {
        return 0;
    }
    let seconds = 0;
    for (let i = 0; i < parts.length; ++i) {
        seconds = seconds * 60 + (parseInt(parts[i], 10) || 0);
    }
    return seconds;
}

/** 页面详情缓存，避免 getMediaSource 和 getMusicInfo 重复请求 */
const detailCache = {};
const DETAIL_TTL = 3 * 60 * 1000;

async function getDetail(id, forceRefresh) {
    const key = String(id);
    const cached = detailCache[key];
    if (!forceRefresh && cached && Date.now() - cached.time < DETAIL_TTL) {
        return cached.data;
    }
    const response = await axios.get(BASE + "/music/" + key, {
        headers: requestHeaders(BASE + "/music/" + key),
        timeout: 15000,
        responseType: "text",
    });
    rememberCookies(response);

    const html = response.data;
    const appData = parseAppData(html);
    if (!appData) {
        return null;
    }

    const $ = cheerio.load(html);
    let lrc = "";
    const lrcHtml = $("#content-lrc").html();
    if (lrcHtml) {
        lrc = lrcHtml
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/p>/gi, "\n");
        lrc = cheerio.load("<div>" + lrc + "</div>")("div").text();
        lrc = lrc.replace(/\r/g, "").replace(/\n{2,}/g, "\n").trim();
    }

    const data = {
        id: key,
        title: appData.mp3_title || "",
        artist: appData.mp3_author || "",
        cover: appData.mp3_cover || "",
        duration: parseDuration(appData.mp3_duration),
        playId: appData.play_id,
        lrc: lrc,
        type: appData.mp3_type,
    };
    detailCache[key] = { time: Date.now(), data: data };
    return data;
}

/** 页面原始 html 缓存（重试时复用，避免频繁刷新） */
const rawPageCache = {};

function parseSongLink(urlLike) {
    const text = String(urlLike || "").trim();
    const byMusic = text.match(/\/music\/(\d+)/);
    if (byMusic) {
        return byMusic[1];
    }
    const bare = text.match(/^(\d+)$/);
    if (bare) {
        return bare[1];
    }
    return "";
}

function toMusicItem(detail) {
    return {
        id: detail.id,
        songId: detail.id,
        title: detail.title,
        artist: detail.artist,
        album: "",
        artwork: secureUrl(detail.cover),
        duration: detail.duration,
    };
}

function secureUrl(url) {
    return String(url || "").replace(/^http:\/\//i, "https://");
}

async function searchMusic(query, page) {
    // 站点搜索固定返回 20 条，没有分页
    const response = await axios.get(BASE + "/search-fallback", {
        params: { keyword: query },
        headers: requestHeaders(BASE + "/search"),
        timeout: 15000,
        responseType: "text",
    });
    rememberCookies(response);

    const $ = cheerio.load(response.data);
    const data = [];
    const seen = {};
    $('a.hover-zoom[href^="/music/"]').each(function () {
        const anchor = $(this);
        const id = parseSongLink(anchor.attr("href"));
        if (!id || seen[id]) {
            return;
        }
        seen[id] = 1;

        let title = anchor.attr("title") || "";
        let artist = "";
        const splitAt = title.lastIndexOf(" - ");
        if (splitAt > 0) {
            artist = title.slice(splitAt + 3).trim();
            title = title.slice(0, splitAt).trim();
        }
        if (!title) {
            title = anchor.find(".text-primary").first().text().trim();
        }
        if (!artist) {
            artist = anchor.find(".text-jade").first().text().trim();
        }
        if (!title) {
            return;
        }

        data.push({
            id: id,
            songId: id,
            title: title,
            artist: artist || "未知",
            album: artist || "",
            artwork: "",
            duration: 0,
        });
    });

    return { isEnd: true, data: data };
}

async function getMediaSource(musicItem) {
    const id = String((musicItem && (musicItem.songId || musicItem.id)) || "");
    if (!id) {
        return null;
    }

    for (let attempt = 0; attempt < 3; ++attempt) {
        const detail = await getDetail(id, attempt > 0);
        if (!detail || !detail.playId) {
            break;
        }

        for (let retry = 0; retry < 4; ++retry) {
            try {
                const response = await axios.post(
                    BASE + "/member/common-play-url",
                    qs.stringify({ id: detail.playId, purpose: "play" }),
                    { headers: apiHeaders(id), timeout: 15000 },
                );
                rememberCookies(response);
                const result = response.data;
                if (result && result.code === 1 && result.data && result.data.url) {
                    // 注意：音频 CDN 带歌曲宝 Referer 会 403，这里不返回任何 headers
                    return { url: result.data.url };
                }
            } catch (e) {}
            await sleep(300);
        }
    }

    return null;
}

async function getMusicInfo(musicBase) {
    const detail = await getDetail(musicBase && musicBase.id);
    if (!detail) {
        return null;
    }
    return {
        title: detail.title,
        artist: detail.artist,
        artwork: secureUrl(detail.cover),
        duration: detail.duration,
    };
}

async function getLyric(musicItem) {
    const detail = await getDetail(musicItem && musicItem.id);
    if (!detail || !detail.lrc) {
        return null;
    }
    return { rawLrc: detail.lrc };
}

async function importMusicItem(urlLike) {
    const id = parseSongLink(urlLike);
    if (!id) {
        return null;
    }
    const detail = await getDetail(id, true);
    if (!detail || !detail.title) {
        return null;
    }
    return toMusicItem(detail);
}

module.exports = {
    platform: "歌曲宝",
    version: "0.0.1",
    srcUrl: SRC_URL,
    author: "",
    description:
        "歌曲宝（gequbao.com）音源。支持搜索、播放、歌词，以及在「导入单曲」中粘贴歌曲页链接（如 https://www.gequbao.com/music/4190）。",
    cacheControl: "no-cache",
    primaryKey: ["id"],
    defaultSearchType: "music",
    supportedSearchType: ["music"],
    hints: {
        importMusicItem: ["粘贴歌曲宝的歌曲页链接，例如 https://www.gequbao.com/music/4190"],
    },
    search: async function (query, page, type) {
        if (type !== "music") {
            return { isEnd: true, data: [] };
        }
        return searchMusic(query, page);
    },
    getMediaSource: getMediaSource,
    getMusicInfo: getMusicInfo,
    getLyric: getLyric,
    importMusicItem: importMusicItem,
};
