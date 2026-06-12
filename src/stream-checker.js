const { net, session } = require('electron');

class StreamChecker {
  constructor() {
    this.cache = new Map();
    this.cacheTTL = 30000; // 30 seconds
  }

  async getChannelAvatar(channel) {
    // Try YouTube first
    if (channel.youtube) {
      try {
        const handle = this._extractYouTubeHandle(channel.youtube);
        if (handle) {
          const html = await this._fetch(`https://www.youtube.com/${handle}`);
          const match = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
                        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
                        html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i);
          if (match && (match[1] || match[2])) {
            return match[1] || match[2];
          }
        }
      } catch (e) {
        console.error('Error fetching YouTube avatar:', e.message);
      }
    }

    // Try Twitch next
    if (channel.twitch) {
      try {
        const username = this._extractTwitchUsername(channel.twitch);
        if (username) {
          const html = await this._fetch(`https://www.twitch.tv/${username}`);
          const match = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
                        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
          if (match && (match[1] || match[2])) {
            return match[1] || match[2];
          }
        }
      } catch (e) {
        console.error('Error fetching Twitch avatar:', e.message);
      }
    }

    // Try Kick last
    if (channel.kick) {
      try {
        const username = this._extractKickUsername(channel.kick);
        if (username) {
          const json = await this._fetch(`https://kick.com/api/v2/channels/${username}`);
          const data = JSON.parse(json);
          const pic = data.user?.profile_pic || data.user?.profilepic || data.profile_pic;
          if (pic) return pic;
        }
      } catch (e) {
        console.error('Error fetching Kick avatar:', e.message);
      }
    }

    return null;
  }

  async checkAll(channels) {
    const results = [];
    for (const channel of channels) {
      const isLive = { youtube: false, twitch: false, kick: false };

      if (channel.youtube) {
        isLive.youtube = await this._checkYouTube(channel.youtube);
      }
      if (channel.twitch) {
        isLive.twitch = await this._checkTwitch(channel.twitch);
      }
      if (channel.kick) {
        isLive.kick = await this._checkKick(channel.kick);
      }

      results.push({ id: channel.id, isLive });
    }
    return results;
  }

  async _checkYouTube(url) {
    try {
      // Extract handle or channel from URL
      const handle = this._extractYouTubeHandle(url);
      if (!handle) return false;

      const checkUrl = `https://www.youtube.com/${handle}/live`;
      const html = await this._fetch(checkUrl);

      // Check canonical link for watch URL (extremely reliable)
      const canonicalMatch = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) ||
                             html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
      if (canonicalMatch) {
        return canonicalMatch[1].includes('/watch?v=') || canonicalMatch[1].includes('youtube.com/watch?v=');
      }

      // Fallback: isLive is true and lengthSeconds is "0"
      return html.includes('"isLive":true') && html.includes('"lengthSeconds":"0"');
    } catch (e) {
      console.error('YouTube check error:', e.message);
      return false;
    }
  }

  async _checkTwitch(url) {
    try {
      const username = this._extractTwitchUsername(url);
      if (!username) return false;

      const checkUrl = `https://www.twitch.tv/${username}`;
      const html = await this._fetch(checkUrl);

      // Twitch live streams include schema.org BroadcastEvent metadata with "isLiveBroadcast":true
      return html.includes('"isLiveBroadcast":true');
    } catch (e) {
      console.error('Twitch check error:', e.message);
      return false;
    }
  }

  async _checkKick(url) {
    try {
      const username = this._extractKickUsername(url);
      if (!username) return false;

      const checkUrl = `https://kick.com/api/v2/channels/${username}`;
      const json = await this._fetch(checkUrl);

      try {
        const data = JSON.parse(json);
        return data.livestream !== null && data.livestream !== undefined && data.livestream.is_live === true;
      } catch {
        return false;
      }
    } catch (e) {
      console.error('Kick check error:', e.message);
      return false;
    }
  }

  _extractYouTubeHandle(url) {
    // Handles: @username, /channel/ID, /c/name
    const match = url.match(/youtube\.com\/(@[^\/\s?]+|channel\/[^\/\s?]+|c\/[^\/\s?]+)/i);
    if (match) return match[1];
    // Maybe it's just the handle
    if (url.startsWith('@')) return url;
    return null;
  }

  _extractTwitchUsername(url) {
    const match = url.match(/twitch\.tv\/([^\/\s?]+)/i);
    return match ? match[1] : url.replace(/^@/, '');
  }

  _extractKickUsername(url) {
    const match = url.match(/kick\.com\/([^\/\s?]+)/i);
    return match ? match[1] : url.replace(/^@/, '');
  }

  async _fetch(url) {
    // Check cache
    const cached = this.cache.get(url);
    if (cached && Date.now() - cached.time < this.cacheTTL) {
      return cached.data;
    }

    const sess = session.fromPartition('persist:stream');
    const response = await net.fetch(url, {
      session: sess,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.text();
    this.cache.set(url, { data, time: Date.now() });
    return data;
  }
}

module.exports = StreamChecker;
