export const USER_AVATARS = [
  { id: "avatar-01", label: "薄荷蓝" },
  { id: "avatar-02", label: "晴空绿" },
  { id: "avatar-03", label: "珊瑚橙" },
  { id: "avatar-04", label: "莓果粉" },
  { id: "avatar-05", label: "深海青" },
  { id: "avatar-06", label: "晨光黄" },
  { id: "avatar-07", label: "紫藤灰" },
  { id: "avatar-08", label: "松石绿" },
];

export const USER_AVATAR_IDS = USER_AVATARS.map((item) => item.id);
export const DEFAULT_USER_AVATAR_ID = USER_AVATAR_IDS[0];

export function isUserAvatarId(value) {
  return USER_AVATAR_IDS.includes(String(value || ""));
}

export function normalizeUserAvatarId(value) {
  return isUserAvatarId(value) ? String(value) : DEFAULT_USER_AVATAR_ID;
}

export function userAvatarPath(value) {
  return `/avatars/${normalizeUserAvatarId(value)}.svg`;
}
