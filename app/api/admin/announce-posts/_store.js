import { redisCmd } from "../../_utils.js";

export const ANNOUNCEMENT_POSTS_KEY = "lm:announce:posts";

export function parseAnnouncementPosts(raw) {
  if (!raw) return [];
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export async function readAnnouncementPosts() {
  return parseAnnouncementPosts(await redisCmd(["GET", ANNOUNCEMENT_POSTS_KEY]));
}

export async function saveAnnouncementPosts(posts) {
  return await redisCmd(["SET", ANNOUNCEMENT_POSTS_KEY, JSON.stringify(posts)]) === "OK";
}

export async function findAnnouncementPost(id) {
  const posts = await readAnnouncementPosts();
  return posts.find((post) => post && Number(post.id) === Number(id)) || null;
}

export function announcementContentVersion(post) {
  return String(Number(post?.updatedAt || post?.createdAt || post?.id || 0));
}
