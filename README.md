# 冒央会社 Next.js 网站包

这是一个已经整理好的 **Next.js 可本地修改版本**，重点是：

- 你发来的 5 张商品图已经放进去了
- 页面是浅色科技风
- 所有主要文案都集中在 `app/page.jsx` 顶部
- 可以本地预览
- 可以部署到 Vercel

---

## 一、文件结构

```text
maoyang-nextjs-site/
├─ app/
│  ├─ globals.css       # 全站样式
│  ├─ layout.jsx        # 全站布局
│  └─ page.jsx          # 首页，主要改这个
├─ public/
│  └─ products/
│     ├─ spotify.jpg
│     ├─ netflix.jpg
│     ├─ disney.jpg
│     ├─ hbomax.jpg
│     └─ rocket.jpg
├─ package.json
├─ .gitignore
└─ README.md
```

---

## 二、本地运行前准备

根据 Next.js 官方文档，App Router 项目最低需要 **Node.js 20.9+**。citeturn221445search0

### 1）安装 Node.js

电脑没有 Node.js 的话，先安装 Node.js 20.9 或更高版本。

安装完后，打开终端检查：

```bash
node -v
npm -v
```

---

## 三、本地运行步骤

### 方式 1：Windows 资源管理器直接解压后运行

1. 把 zip 解压到任意文件夹，例如：
   `D:\website\maoyang-nextjs-site`
2. 进入这个文件夹
3. 在地址栏输入 `cmd` 回车，或者右键“在终端中打开”
4. 依次运行：

```bash
npm install
npm run dev
```

5. 打开浏览器访问：

```text
http://localhost:3000
```

Next.js 本地开发服务器默认在 `localhost:3000` 运行。citeturn221445search0

---

## 四、你最需要改的地方

## 1）改品牌、标题、FAQ、客服、备案位

打开：

```text
app/page.jsx
```

最上面会看到：

```js
const SITE_CONTENT = {
  ...
}
```

你主要改这里：

- `brandCn`：中文品牌名
- `brandEn`：英文品牌名
- `domain`：域名
- `heroBadge`：首页小标签
- `heroTitleLine1` / `heroTitleHighlight` / `heroTitleLine2`：首页主标题
- `heroDesc`：首页介绍文案
- `faq`：FAQ 内容
- `supportItems`：客服信息
- `footerRecord`：备案号位置
- `footerNote`：页脚补充说明

---

## 2）改商品内容

还是在：

```text
app/page.jsx
```

找到：

```js
const PRODUCTS = [
  ...
]
```

每个商品都可以改这些字段：

- `title`：商品名称
- `subtitle`：副标题
- `price`：价格
- `shortIntro`：卡片短简介
- `highlights`：卖点数组
- `detailTitle`：点开后的详情标题
- `detailBody`：点开后的完整详情
- `orderTitle`：下单弹窗标题
- `orderBody`：下单弹窗说明
- `qrHint`：二维码位置提示文字
- `qrImage`：二维码图片路径

### 二维码如何替换

当前 `qrImage` 为空，所以显示的是占位框。

你可以这样做：

1. 自己准备二维码图片，例如：
   `public/payment/spotify-qr.jpg`
2. 然后在对应商品里改：

```js
qrImage: "/payment/spotify-qr.jpg"
```

这样点击商品详情，再点“预览下单弹窗位置”时，就会显示这张二维码图。

---

## 3）改商品图片

图片现在在：

```text
public/products/
```

分别是：

- `spotify.jpg`
- `netflix.jpg`
- `disney.jpg`
- `hbomax.jpg`
- `rocket.jpg`

### 最简单替换方法

直接把你自己的新图片改成同样文件名，再覆盖原文件。

例如你要换 Spotify 图：

- 新图片命名为 `spotify.jpg`
- 覆盖到 `public/products/spotify.jpg`

刷新页面后就会更新。

### 另一种方法

也可以不改文件名，而是到 `app/page.jsx` 里改：

```js
image: "/products/你的新图片名.jpg"
```

---

## 4）改样式颜色、圆角、阴影

打开：

```text
app/globals.css
```

这里能改：

- 页面背景色
- 卡片背景色
- 按钮颜色
- 阴影强度
- 圆角大小
- 字体大小
- 弹窗样式

### 常用位置

顶部变量区：

```css
:root {
  --bg: #f5f7fb;
  --card: rgba(255, 255, 255, 0.86);
  --primary: #111827;
  --accent: #0f766e;
}
```

这里是最好改的地方。

---

## 五、本地修改后怎么看效果

只要你已经运行：

```bash
npm run dev
```

然后保存文件，浏览器一般会自动刷新。

你改完 `page.jsx` 或 `globals.css`，刷新 `http://localhost:3000` 就能看到新效果。

---

## 六、怎么打包成正式上线版本

本地确认没问题后，在项目目录运行：

```bash
npm run build
```

如果构建成功，再运行：

```bash
npm run start
```

然后访问：

```text
http://localhost:3000
```

这就是生产模式预览。

---

## 七、怎么部署到 Vercel

Vercel 官方文档说明，你可以通过 **Git 仓库导入** 或 **Vercel CLI** 部署项目；导入 Git 仓库后，后续推送会自动触发部署。citeturn221445search1turn221445search3turn221445search9

### 方案 A：最推荐，GitHub + Vercel

#### 第一步：把项目传到 GitHub

在项目目录打开终端：

```bash
git init
git add .
git commit -m "init site"
```

然后在 GitHub 新建一个仓库，再执行：

```bash
git branch -M main
git remote add origin 你的仓库地址
git push -u origin main
```

#### 第二步：去 Vercel 导入

1. 登录 Vercel
2. 新建 Project
3. 选择 Import Git Repository
4. 选择你的 GitHub 仓库
5. 保持默认设置直接 Deploy

Vercel 的 Git 导入方式支持 GitHub 项目自动部署，并且后续每次 push 都会触发新的部署。citeturn221445search1turn221445search3turn221445search9

#### 第三步：绑定域名 `liumeiti.vip`

部署成功后：

1. 进入该项目
2. 打开 Domains
3. 添加 `liumeiti.vip`
4. 按 Vercel 提示去你的域名解析商处添加解析记录

Vercel 在项目中支持自定义域名绑定。citeturn221445search1

---

### 方案 B：用 Vercel CLI 直接部署

Vercel 官方文档也提供了从项目根目录直接运行 `vercel` 命令的方式。citeturn221445search5turn221445search7

先安装：

```bash
npm install -g vercel
```

然后在项目目录运行：

```bash
vercel
```

第一次会让你登录、关联项目，跟着提示走即可。

正式部署可用：

```bash
vercel --prod
```

---

## 八、最省事的修改顺序

你可以按这个顺序改，效率最高：

1. 先改 `app/page.jsx` 顶部的 `SITE_CONTENT`
2. 再改 `PRODUCTS`
3. 再替换 `public/products/` 里的图片
4. 如需二维码预览，再补 `qrImage`
5. 最后去 `app/globals.css` 微调颜色和阴影
6. 本地确认没问题后，再部署到 Vercel

---

## 九、容易出错的地方

### 1）图片不显示

通常是路径写错。

例如：

```js
image: "/products/spotify.jpg"
```

表示文件必须真的存在于：

```text
public/products/spotify.jpg
```

### 2）改了没反应

先确认你保存了文件，再看运行窗口有没有报错。

### 3）`npm install` 失败

一般是 Node 版本太低。先检查：

```bash
node -v
```

Next.js App Router 最低需要 Node.js 20.9+。citeturn221445search0

### 4）Vercel 构建失败

通常是你改代码时少了逗号、引号、括号，或者图片路径写错。

---

## 十、你最常改的两个文件

### 文案和结构

```text
app/page.jsx
```

### 样式和颜色

```text
app/globals.css
```

---

## 十一、后续你自己能加什么

你后续可以自己继续加：

- 真正的表单提交接口
- 邮件通知
- Telegram Bot 通知
- 数据库存订单
- 隐私政策页
- 服务条款页
- 独立 FAQ 页面
- 多页面结构

---

## 十二、当前这个包是什么状态

这是一个 **可本地修改、可预览、可部署的 Next.js 网站包**。

它现在已经包含：

- 浅色科技风首页
- 商品卡片区
- 商品详情弹窗
- 下单弹窗预览区
- 客服悬浮按钮
- 联系表单占位
- FAQ
- 页脚备案位
- 已接入你上传的 5 张商品图片

你现在最需要做的，就是改 `app/page.jsx` 顶部内容区。
