# igfetch_fetch.py — duplicate of fetch_instagram_looter.py (adapted for mainspring.dxb)

"""
Instagram Looter API Fetcher (prefixed copy)
Copy this file into the repo's `scripts/` folder and run with:

export RAPIDAPI_KEY='YOUR_KEY'
python3 scripts/igfetch_fetch.py --username mainspring.dxb --count 6

This file is identical in behavior to `fetch_instagram_looter.py`.
"""

import os
import json
import requests
import sys

def fetch_user_posts_looter(username="mainspring.dxb", limit=6):
    api_key = os.environ.get('RAPIDAPI_KEY')
    if not api_key:
        print("ERROR: RAPIDAPI_KEY environment variable not set")
        print("\nSet it with:")
        print("export RAPIDAPI_KEY='your_key_here'")
        sys.exit(1)
    
    api_host = "instagram-looter2.p.rapidapi.com"
    headers = {"X-RapidAPI-Key": api_key, "X-RapidAPI-Host": api_host}

    print(f"Fetching Instagram posts for @{username}...")

    base = f"https://{api_host}"
    os.makedirs('data', exist_ok=True)
    os.makedirs('images', exist_ok=True)

    try:
        profile_url = f"{base}/profile2"
        resp = requests.get(profile_url, headers=headers, params={"username": username}, timeout=30)
        if resp.status_code != 200:
            print(f"Failed to get profile: HTTP {resp.status_code}")
            print(resp.text[:500])
            sys.exit(1)
        profile = resp.json()

        user_id = None
        if isinstance(profile, dict):
            user_id = (profile.get('id') or profile.get('user_id') or profile.get('pk') or
                       (profile.get('data') and profile.get('data').get('id')))
        if not user_id and isinstance(profile.get('user'), dict):
            user_id = profile['user'].get('id') or profile['user'].get('pk')
        if not user_id:
            print("Could not determine user ID from profile response:")
            print(json.dumps(profile, indent=2)[:1000])
            sys.exit(1)

        print(f"Detected user id: {user_id}")

        feeds_url = f"{base}/user-feeds2"
        feeds_resp = requests.get(feeds_url, headers=headers, params={"id": user_id, "count": limit}, timeout=30)
        if feeds_resp.status_code != 200:
            print(f"Failed to get feeds: HTTP {feeds_resp.status_code}")
            print(feeds_resp.text[:500])
            sys.exit(1)

        feeds = feeds_resp.json()
        # dump raw feeds response for debugging
        try:
            with open('data/instagram_raw.json', 'w', encoding='utf-8') as rf:
                json.dump(feeds, rf, indent=2, ensure_ascii=False)
            print("Saved raw feeds response to data/instagram_raw.json")
        except Exception as e:
            print(f"Could not save raw feeds response: {e}")
        items = []
        if isinstance(feeds, dict):
            try:
                edges = feeds.get('data', {}).get('user', {}).get('edge_owner_to_timeline_media', {}).get('edges')
                if edges and isinstance(edges, list):
                    items = [e.get('node') if isinstance(e, dict) and 'node' in e else e for e in edges]
            except Exception:
                items = []
            if not items:
                items = (feeds.get('items') or feeds.get('media') or feeds.get('feeds') or feeds.get('data') or [])
                if isinstance(items, dict):
                    items = items.get('edges') or list(items.values())
        elif isinstance(feeds, list):
            items = feeds

        if not items:
            print("No media items found in feeds response:")
            print(json.dumps(feeds, indent=2)[:1000])
            sys.exit(1)

        posts_data = []
        for i, item in enumerate(items[:limit]):
            node = item if isinstance(item, dict) else None
            if node is None:
                continue
            shortcode = node.get('shortcode') or node.get('code') or node.get('id') or str(i)
            permalink = node.get('permalink') or node.get('post_url') or node.get('link') or f"https://www.instagram.com/p/{shortcode}/"
            media_url = (node.get('display_url') or node.get('video_url') or node.get('thumbnail_src') or node.get('image') or node.get('image_url') or node.get('media_url'))
            local_image_path = f"images/ig_{shortcode}.jpg"

            if not media_url:
                try:
                    post_info_url = f"{base}/post"
                    p_resp = requests.get(post_info_url, headers=headers, params={"url": permalink}, timeout=30)
                    if p_resp.status_code == 200:
                        pjson = p_resp.json()
                        media_url = (pjson.get('media_url') or pjson.get('display_url') or pjson.get('image') or pjson.get('video_url') or pjson.get('download_url'))
                except Exception:
                    pass

            if not media_url:
                try:
                    dl_url = f"{base}/post-dl"
                    dl_resp = requests.get(dl_url, headers=headers, params={"url": permalink}, timeout=30)
                    if dl_resp.status_code == 200:
                        djson = dl_resp.json()
                        media_url = djson.get('download_url') or djson.get('url') or djson.get('video_url')
                except Exception:
                    pass

            if media_url and not os.path.exists(local_image_path):
                try:
                    img_r = requests.get(media_url, timeout=30)
                    if img_r.status_code == 200:
                        with open(local_image_path, 'wb') as f:
                            f.write(img_r.content)
                except Exception as e:
                    print(f"Warning: could not download {media_url}: {e}")

            caption = ''
            try:
                cap_edges = node.get('edge_media_to_caption', {}).get('edges')
                if cap_edges and isinstance(cap_edges, list) and cap_edges[0].get('node'):
                    caption = cap_edges[0]['node'].get('text','')
            except Exception:
                pass
            if not caption:
                caption = node.get('caption') or node.get('title') or ''

            posts_data.append({
                "shortcode": shortcode,
                "url": permalink,
                "image_url": local_image_path,
                "caption": caption
            })

        with open('data/instagram.json', 'w', encoding='utf-8') as f:
            json.dump(posts_data, f, indent=4, ensure_ascii=False)

        print(f"Fetched {len(posts_data)} posts for @{username}")
        return posts_data

    except Exception as e:
        print(f"Error: {e}")
        import traceback; traceback.print_exc(); sys.exit(1)

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--username","-u", default="mainspring.dxb")
    parser.add_argument("--count","-c", type=int, default=6)
    args = parser.parse_args()
    fetch_user_posts_looter(username=args.username, limit=args.count)
