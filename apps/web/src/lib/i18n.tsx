import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

// Copy is taken verbatim from the design files (Nampu Creator / Contribute & Login).
// Keys marked "(added)" have no counterpart in the design.
const th = {
  // common
  back: 'ย้อนกลับ',
  next: 'ถัดไป',
  edit: 'แก้ไข',
  add: 'เพิ่ม',
  copy: 'คัดลอก',
  copied: 'คัดลอกแล้ว',
  close: 'ปิด',
  comingSoon: 'เร็วๆ นี้', // (added)
  retry: 'ลองอีกครั้ง', // (added)
  somethingWrong: 'เกิดข้อผิดพลาด', // (added)
  rateLimited: 'ส่งคำขอถี่เกินไป รอสักครู่แล้วลองใหม่อีกครั้ง', // (added)
  days: 'วัน',
  logout: 'ออกจากระบบ', // (added)
  switchTheme: 'สลับธีม', // (added)
  newProject: 'สร้างโปรเจกต์ใหม่', // (added)

  // login (4a/4b)
  loginTitle: 'เข้าสู่ระบบ',
  loginSub: 'ใช้ตัวตน Nostr หรือกระเป๋า Lightning ของคุณ ไม่ต้องใช้อีเมลหรือรหัสผ่าน',
  extension: 'ส่วนขยายเบราว์เซอร์',
  signer: 'แอปเซ็นชื่อ (Amber, nsec.app)',
  orBunker: 'หรือวางลิงก์ bunker',
  bunkerLabel: 'Nostr Connect',
  bunkerPlaceholderMobile: 'bunker://… หรือ name@nsec.app',
  noExt: 'ไม่พบส่วนขยาย Nostr ในเบราว์เซอร์นี้ ลองใช้แอปเซ็นชื่อ หรือ LNURL-auth แทน',
  scanWait: 'รอการยืนยันจากกระเป๋า',
  lnHelp: 'สแกนด้วยกระเป๋าที่รองรับ LNURL-auth เช่น Alby, Phoenix, Zeus',
  copyLink: 'คัดลอกลิงก์',
  openWallet: 'เปิดกระเป๋า',
  privacy: 'เราไม่เก็บ private key และไม่ขออีเมล',
  connect: 'เชื่อมต่อ',
  signerWaiting: 'รอแอปเซ็นชื่อ…', // (added)
  loginExpired: 'QR หมดอายุแล้ว', // (added)
  loginFailed: 'เข้าสู่ระบบไม่สำเร็จ', // (added)
  bunkerInvalid: 'ลิงก์ bunker ไม่ถูกต้อง', // (added)

  // onboarding (added — not in the design)
  welcomeTitle: 'ตั้งชื่อที่แสดง',
  welcomeSub: 'ชื่อนี้จะแสดงบนโปรเจกต์ของคุณ เปลี่ยนภายหลังได้',
  fDisplayName: 'ชื่อที่แสดง',
  fHandle: 'ชื่อผู้ใช้',
  handleHint: 'ตัวอักษรอังกฤษพิมพ์เล็ก ตัวเลข และ - เท่านั้น',
  prefilled: 'ดึงมาจากโปรไฟล์ Nostr ของคุณ',
  continue: 'เริ่มใช้งาน',
  handleTaken: 'ชื่อผู้ใช้นี้ถูกใช้แล้ว',

  // wizard (6a/6b)
  saveDraft: 'บันทึกร่าง',
  publish: 'เผยแพร่โปรเจกต์',
  stepN: 'ขั้นที่',
  of: 'จาก',
  s1: 'ข้อมูลพื้นฐาน',
  s1sub: 'ชื่อ คำโปรย และภาพปกที่จะแสดงบนการ์ด',
  s2: 'เรื่องราว',
  s2sub: 'เล่าว่าทำอะไร ทำไม และจะใช้เงินอย่างไร',
  s3: 'เป้าหมายและระยะเวลา',
  s3sub: 'ยอดเป้าหมายเป็น sats และเป้าหมายย่อย',
  s4: 'รางวัล',
  s4sub: 'สิ่งที่ผู้สนับสนุนจะได้รับ',
  s5: 'รับเงินและตรวจทาน',
  s5sub: 'ปลายทางที่ sats จะเข้าโดยตรง',
  fTitle: 'ชื่อโปรเจกต์',
  fSlug: 'ลิงก์โปรเจกต์', // (added; Foundations shows a slug input)
  slugHint: 'ตัวอักษรอังกฤษพิมพ์เล็ก ตัวเลข และ - เปลี่ยนไม่ได้หลังเผยแพร่',
  slugTaken: 'ลิงก์นี้ถูกใช้แล้ว',
  fBlurb: 'คำโปรยสั้นๆ',
  fCat: 'หมวดหมู่',
  fCover: 'ภาพปก',
  upload: 'แตะเพื่ออัปโหลด · 16:9 · ไม่เกิน 5 MB',
  removeCover: 'ลบภาพปก', // (added)
  uploading: 'กำลังอัปโหลด…', // (added)
  fileTooLarge: 'ไฟล์ใหญ่เกิน 5 MB', // (added)
  storyPlaceholder: 'เล่าเรื่องของโปรเจกต์ (รองรับ Markdown)', // (added)
  fGoal: 'เป้าหมาย',
  fEnd: 'วันสิ้นสุด',
  noEnd: 'ไม่กำหนด', // (added)
  milestones: 'เป้าหมายย่อย',
  msDesc: 'รายละเอียด',
  status: 'สถานะ',
  reached: 'สำเร็จ',
  inProgress: 'กำลังไป',
  addReward: 'เพิ่มรางวัล',
  rewardsOptional: 'รางวัลไม่บังคับ โปรเจกต์ที่มีรางวัลมักได้ผู้สนับสนุนมากกว่า',
  lnOk: 'ตรวจสอบแล้ว รับ sats ได้',
  lnChecking: 'กำลังตรวจสอบ…', // (added)
  lnFormat: 'รูปแบบต้องเป็น name@domain.com',
  fNpub: 'Nostr npub (สำหรับประกาศและ zap)',
  review: 'ตรวจทาน',
  savedAgo: 'บันทึกอัตโนมัติ {ago}ที่แล้ว',
  savedJustNow: 'บันทึกอัตโนมัติแล้ว', // (added)
  saving: 'กำลังบันทึก…', // (added)
  unsaved: 'ยังไม่ได้บันทึก', // (added)
  preview: 'ดูตัวอย่าง',
  saveChanges: 'บันทึกการเปลี่ยนแปลง',
  editProject: 'แก้ไขโปรเจกต์',
  createProject: 'สร้างโปรเจกต์', // (added)
  fGoalLocked: 'หมายเหตุ',
  lockedNote: 'โปรเจกต์เผยแพร่แล้ว ลดเป้าหมายต่ำกว่ายอดที่ได้รับแล้ว ({raised} sats) ไม่ได้',
  livePreview: 'ตัวอย่างการ์ด',
  needTitleSlug: 'ใส่ชื่อและลิงก์โปรเจกต์ก่อน', // (added)
  publishNeedsLn: 'ใส่ Lightning address ก่อนเผยแพร่', // (added)
  closeProject: 'ปิดรับการสนับสนุน', // (added)
  reopenProject: 'เปิดรับอีกครั้ง', // (added)

  cats: { edu: 'การศึกษา', media: 'สื่อ', tech: 'เทคโนโลยี', community: 'ชุมชน', art: 'ศิลปะ' },

  // dashboard (5a/5b)
  dashboard: 'แดชบอร์ดผู้สร้าง',
  received: 'ยอดที่ได้รับ',
  receivedAll: 'ยอดรับทั้งหมด',
  backers: 'ผู้สนับสนุน',
  avg: 'เฉลี่ย/คน',
  ofGoal: 'ของเป้า',
  supporters: 'ผู้สนับสนุน',
  overview: 'ภาพรวม',
  updatesNav: 'อัปเดต',
  rewards: 'รางวัล',
  explore: 'สำรวจ',
  share: 'แชร์',
  postUpdate: 'โพสต์อัปเดต',
  last7: '7 วันล่าสุด',
  anonCount: '{n} คนไม่ระบุชื่อ',
  rewardsToSend: 'รางวัลที่ต้องส่ง',
  searchSup: 'ค้นหาชื่อหรือข้อความ',
  all: 'ทั้งหมด',
  withReward: 'มีรางวัล',
  withMsg: 'มีข้อความ',
  supporter: 'ผู้สนับสนุน',
  message: 'ข้อความ',
  reward: 'รางวัล',
  when: 'เวลา',
  anonymous: 'ไม่ระบุชื่อ',
  ranges: { today: 'วันนี้', '7d': '7 วัน', '30d': '30 วัน', all: 'ทั้งหมด' },
  deltaToday: '+{n} คนวันนี้',
  deltaWeek: '{pct} จากสัปดาห์ก่อน',
  deltaMonth: '{pct} จากเดือนก่อน',
  since: 'ตั้งแต่ {date}',
  noSupporters: 'ยังไม่มีผู้สนับสนุน แชร์โปรเจกต์เพื่อเริ่มรับ sats', // (added)
  noMatches: 'ไม่พบผู้สนับสนุนที่ตรงกับการค้นหา', // (added)
  draftBanner: 'โปรเจกต์นี้ยังเป็นร่าง เผยแพร่เพื่อเริ่มรับการสนับสนุน', // (added)
  closedBanner: 'โปรเจกต์นี้ปิดรับการสนับสนุนแล้ว', // (added)
  loadMore: 'ดูเพิ่มเติม', // (added)
  linkCopied: 'คัดลอกลิงก์แล้ว', // (added)
  // discover (1a/1c) — nampu Discover & Project
  heroTitle: 'ระดมทุนด้วย Bitcoin ให้คนที่ลงมือทำ',
  heroSub: 'สนับสนุนโปรเจกต์ในชุมชนผ่าน Lightning โดยตรง ไม่มีตัวกลางถือเงิน ยอดเข้ากระเป๋าผู้สร้างทันที',
  searchProjects: 'ค้นหาโปรเจกต์',
  searchShort: 'ค้นหา',
  trending: 'กำลังมาแรง',
  trendingWeek: 'มาแรงสัปดาห์นี้',
  daysShort: 'วัน',
  start: 'เริ่มโปรเจกต์',
  account: 'บัญชี',
  how: 'วิธีการทำงาน',
  login: 'เข้าสู่ระบบ',
  sortBy: 'เรียงตาม: {sort}',
  sorts: { trending: 'มาแรง', new: 'ใหม่ล่าสุด', ending: 'ใกล้หมดเวลา', funded: 'ใกล้ครบเป้า' },
  emptyCat: 'ยังไม่มีโปรเจกต์ในหมวดนี้',
  emptySearch: 'ไม่พบโปรเจกต์ที่ตรงกับการค้นหา', // (added)
  catAll: 'ทั้งหมด',
  // how it works (added — no design)
  howTitle: 'ล้นหลามทำงานอย่างไร',
  how1t: 'ผู้สร้างใส่ Lightning address',
  how1b: 'ไม่ต้องฝากเงินไว้กับเรา ผู้สร้างใช้กระเป๋า Lightning ของตัวเองที่รองรับการยืนยันการจ่าย (LUD-21)',
  how2t: 'ผู้สนับสนุนสแกน QR',
  how2b: 'เลือกจำนวน sats แล้วจ่ายด้วยกระเป๋า Lightning ใดก็ได้ ไม่ต้องสมัครสมาชิก',
  how3t: 'sats เข้ากระเป๋าผู้สร้างทันที',
  how3b: 'invoice ออกโดยกระเป๋าของผู้สร้างเอง ล้นหลามไม่ถือเงินของใคร เราแค่ยืนยันและแสดงยอดแบบสด',

  // project page (2a/2c)
  by: 'โดย',
  ofGoalSats: 'จากเป้า',
  funded: 'ของเป้าหมาย',
  daysLeft: 'วันที่เหลือ',
  contribute: 'สนับสนุน',
  story: 'เรื่องราว',
  leaderboard: 'ผู้สนับสนุนสูงสุด',
  activity: 'ความเคลื่อนไหว',
  anonNote: 'สนับสนุนแบบไม่ระบุชื่อได้',
  sent: 'สนับสนุน {amount} sats',
  projectClosed: 'ปิดรับการสนับสนุนแล้ว', // (added)
  projectNotFound: 'ไม่พบโปรเจกต์นี้', // (added)
  backHome: 'กลับหน้าแรก', // (added)
  noActivity: 'ยังไม่มีผู้สนับสนุน เป็นคนแรกเลย!', // (added)
  shareText: 'ร่วมสนับสนุน “{title}” ด้วย Bitcoin Lightning บนล้นหลาม', // (added)
  shared: 'โพสต์ลง Nostr แล้ว', // (added)

  // contribute (3a/3c + Invoice Sheet)
  supporting: 'กำลังสนับสนุน',
  presetNotes: ['ทักทาย', 'กาแฟหนึ่งแก้ว', '', 'เลขมงคล', '', ''],
  anonToggle: 'ไม่แสดงชื่อของฉัน',
  namePh: 'ชื่อที่จะแสดง (ไม่บังคับ)', // (added)
  fromNostr: 'ใช้ชื่อจาก Nostr', // (added)
  msgPh: 'ข้อความถึงผู้สร้าง (ไม่บังคับ)',
  createInvoice: 'สร้าง invoice',
  creating: 'กำลังสร้าง Lightning invoice…',
  waiting: 'รอการชำระเงิน',
  expiresIn: 'หมดอายุใน',
  expiredTag: 'หมดอายุแล้ว',
  expiredBody: 'invoice นี้หมดอายุแล้ว ยังไม่มีการหักเงิน สร้างใหม่ได้ด้วยจำนวนเดิม',
  copiedToast: 'คัดลอก invoice แล้ว',
  openLnWallet: 'เปิดกระเป๋า Lightning',
  newInvoice: 'สร้าง invoice ใหม่',
  errTitle: 'สร้าง invoice ไม่สำเร็จ',
  errBody: 'เชื่อมต่อโหนดของผู้สร้างไม่ได้ในขณะนี้ ยังไม่มีการหักเงินจากคุณ',
  changeAmount: 'เปลี่ยนจำนวน',
  thanks: 'ขอบคุณ!',
  creatorReceived: 'ผู้สร้างได้รับ sats ของคุณแล้ว',
  amountL: 'จำนวน',
  shownAs: 'แสดงเป็น',
  timeL: 'เวลา',
  backToProject: 'กลับไปที่โปรเจกต์',
  nonCustodial: 'sats ส่งตรงถึงผู้สร้างผ่าน Lightning ล้นหลามไม่ถือเงินของใคร',
  scanDesk: 'สแกนด้วยกระเป๋า Lightning บนมือถือ หรือคัดลอกไปวางในกระเป๋าบนเครื่องนี้',
  scanToPay: 'เลือกจำนวนแล้วกดสร้าง invoice เพื่อแสดง QR', // (added)
  cancelTitle: 'ยกเลิกการสนับสนุน?',
  cancelBody: 'invoice นี้จะถูกยกเลิก ถ้าคุณจ่ายไปแล้ว ยอดจะยังเข้าโปรเจกต์ตามปกติ',
  cancelKeep: 'กลับไป',
  cancelConfirm: 'ยกเลิก invoice',
  customAmount: 'ใส่จำนวนเอง', // (added)
  ago: { now: 'เมื่อสักครู่', m: '{n} นาที', h: '{n} ชม.', yesterday: 'เมื่อวาน', d: '{n} วัน' },
}

type Dict = typeof th

const en: Dict = {
  back: 'Back',
  next: 'Next',
  edit: 'Edit',
  add: 'Add',
  copy: 'Copy',
  copied: 'Copied',
  close: 'Close',
  comingSoon: 'Coming soon',
  retry: 'Try again',
  somethingWrong: 'Something went wrong',
  rateLimited: 'Too many requests. Please wait a moment and try again.',
  days: 'days',
  logout: 'Log out',
  switchTheme: 'Toggle theme',
  newProject: 'New project',

  loginTitle: 'Log in',
  loginSub: 'Use your Nostr identity or Lightning wallet. No email, no password.',
  extension: 'Browser extension',
  signer: 'Signer app (Amber, nsec.app)',
  orBunker: 'or paste a bunker link',
  bunkerLabel: 'Nostr Connect',
  bunkerPlaceholderMobile: 'bunker://… or name@nsec.app',
  noExt: 'No Nostr extension found in this browser. Try a signer app or LNURL-auth instead.',
  scanWait: 'Waiting for your wallet',
  lnHelp: 'Scan with a wallet that supports LNURL-auth, such as Alby, Phoenix or Zeus.',
  copyLink: 'Copy link',
  openWallet: 'Open wallet',
  privacy: 'We never store private keys or ask for email.',
  connect: 'Connect',
  signerWaiting: 'Waiting for signer…',
  loginExpired: 'QR code expired',
  loginFailed: 'Login failed',
  bunkerInvalid: 'Invalid bunker link',

  welcomeTitle: 'Set your display name',
  welcomeSub: 'Shown on your projects. You can change it later.',
  fDisplayName: 'Display name',
  fHandle: 'Username',
  handleHint: 'Lowercase letters, numbers and - only',
  prefilled: 'Taken from your Nostr profile',
  continue: 'Get started',
  handleTaken: 'That username is taken',

  saveDraft: 'Save draft',
  publish: 'Publish project',
  stepN: 'Step',
  of: 'of',
  s1: 'Basics',
  s1sub: 'Title, one-line pitch and the cover shown on cards',
  s2: 'Story',
  s2sub: 'What you’re making, why, and how funds will be used',
  s3: 'Goal and timeline',
  s3sub: 'Your target in sats, plus milestones',
  s4: 'Rewards',
  s4sub: 'What supporters receive',
  s5: 'Payout and review',
  s5sub: 'Where sats land, directly',
  fTitle: 'Project title',
  fSlug: 'Project link',
  slugHint: 'Lowercase letters, numbers and -. Locked once published.',
  slugTaken: 'That link is taken',
  fBlurb: 'Short pitch',
  fCat: 'Category',
  fCover: 'Cover image',
  upload: 'Tap to upload · 16:9 · max 5 MB',
  removeCover: 'Remove cover',
  uploading: 'Uploading…',
  fileTooLarge: 'File is larger than 5 MB',
  storyPlaceholder: 'Tell the story of your project (Markdown supported)',
  fGoal: 'Goal',
  fEnd: 'End date',
  noEnd: 'None',
  milestones: 'Milestones',
  msDesc: 'Description',
  status: 'Status',
  reached: 'Reached',
  inProgress: 'In progress',
  addReward: 'Add reward',
  rewardsOptional: 'Rewards are optional, but projects with rewards tend to attract more backers.',
  lnOk: 'Verified, can receive sats',
  lnChecking: 'Checking…',
  lnFormat: 'Must look like name@domain.com',
  fNpub: 'Nostr npub (for announcements and zaps)',
  review: 'Review',
  savedAgo: 'Autosaved {ago} ago',
  savedJustNow: 'Autosaved',
  saving: 'Saving…',
  unsaved: 'Unsaved changes',
  preview: 'Preview',
  saveChanges: 'Save changes',
  editProject: 'Edit project',
  createProject: 'Create project',
  fGoalLocked: 'Note',
  lockedNote: 'This project is live. The goal can’t go below what you’ve already raised ({raised} sats).',
  livePreview: 'Card preview',
  needTitleSlug: 'Add a title and project link first',
  publishNeedsLn: 'Add a Lightning address before publishing',
  closeProject: 'Stop accepting support',
  reopenProject: 'Reopen',

  cats: { edu: 'Education', media: 'Media', tech: 'Tech', community: 'Community', art: 'Culture' },

  dashboard: 'Creator dashboard',
  received: 'Received',
  receivedAll: 'Total received',
  backers: 'Backers',
  avg: 'Avg / backer',
  ofGoal: 'of goal',
  supporters: 'Supporters',
  overview: 'Overview',
  updatesNav: 'Updates',
  rewards: 'Rewards',
  explore: 'Explore',
  share: 'Share',
  postUpdate: 'Post update',
  last7: 'Last 7 days',
  anonCount: '{n} anonymous',
  rewardsToSend: 'Rewards to send',
  searchSup: 'Search name or message',
  all: 'All',
  withReward: 'With reward',
  withMsg: 'With message',
  supporter: 'Supporter',
  message: 'Message',
  reward: 'Reward',
  when: 'When',
  anonymous: 'Anonymous',
  ranges: { today: 'Today', '7d': '7d', '30d': '30d', all: 'All' },
  deltaToday: '+{n} backers today',
  deltaWeek: '{pct} vs last week',
  deltaMonth: '{pct} vs last month',
  since: 'since {date}',
  noSupporters: 'No supporters yet. Share your project to start receiving sats.',
  noMatches: 'No supporters match your search.',
  draftBanner: 'This project is still a draft. Publish it to start receiving support.',
  closedBanner: 'This project is no longer accepting support.',
  loadMore: 'Load more',
  linkCopied: 'Link copied',
  heroTitle: 'Bitcoin crowdfunding for people who build',
  heroSub: 'Back community projects directly over Lightning. No custodian in the middle: sats reach the creator the moment you pay.',
  searchProjects: 'Search projects',
  searchShort: 'Search',
  trending: 'Trending',
  trendingWeek: 'Trending this week',
  daysShort: 'days',
  start: 'Start a project',
  account: 'Account',
  how: 'How it works',
  login: 'Log in',
  sortBy: 'Sort: {sort}',
  sorts: { trending: 'trending', new: 'newest', ending: 'ending soon', funded: 'nearly funded' },
  emptyCat: 'No projects in this category yet',
  emptySearch: 'No projects match your search.',
  catAll: 'All',
  howTitle: 'How Lonlaam works',
  how1t: 'Creators add a Lightning address',
  how1b: 'Nothing is deposited with us. Creators use their own Lightning wallet that supports payment verification (LUD-21).',
  how2t: 'Supporters scan a QR',
  how2b: 'Pick an amount in sats and pay from any Lightning wallet. No sign-up needed.',
  how3t: 'Sats land with the creator instantly',
  how3b: 'Invoices are issued by the creator’s own wallet. Lonlaam never holds funds; we only confirm payments and show totals live.',

  by: 'by',
  ofGoalSats: 'of',
  funded: 'funded',
  daysLeft: 'days left',
  contribute: 'Contribute',
  story: 'Story',
  leaderboard: 'Top supporters',
  activity: 'Activity',
  anonNote: 'You can contribute anonymously',
  sent: 'sent {amount} sats',
  projectClosed: 'No longer accepting support',
  projectNotFound: 'Project not found',
  backHome: 'Back to home',
  noActivity: 'No supporters yet. Be the first!',
  shareText: 'Support “{title}” with Bitcoin Lightning on Lonlaam',
  shared: 'Posted to Nostr',

  supporting: 'Supporting',
  presetNotes: ['say hi', 'a coffee', '', 'the classic', '', ''],
  anonToggle: 'Hide my name',
  namePh: 'Name to show (optional)',
  fromNostr: 'Use my Nostr name',
  msgPh: 'Message to the creator (optional)',
  createInvoice: 'Create invoice',
  creating: 'Creating Lightning invoice…',
  waiting: 'Waiting for payment',
  expiresIn: 'expires in',
  expiredTag: 'Expired',
  expiredBody: 'This invoice has expired and nothing was charged. Create a new one for the same amount.',
  copiedToast: 'Invoice copied',
  openLnWallet: 'Open Lightning wallet',
  newInvoice: 'New invoice',
  errTitle: 'Couldn’t create invoice',
  errBody: 'The creator’s node is unreachable right now. You have not been charged.',
  changeAmount: 'Change amount',
  thanks: 'Thank you!',
  creatorReceived: 'The creator has received your sats',
  amountL: 'Amount',
  shownAs: 'Shown as',
  timeL: 'Time',
  backToProject: 'Back to project',
  nonCustodial: 'Sats go straight to the creator over Lightning. Lonlaam never holds anyone’s funds.',
  scanDesk: 'Scan with a mobile Lightning wallet, or copy it into a wallet on this device.',
  scanToPay: 'Pick an amount and create an invoice to show the QR',
  cancelTitle: 'Cancel your contribution?',
  cancelBody: 'This invoice will be discarded. If you already paid, it still reaches the project as usual.',
  cancelKeep: 'Go back',
  cancelConfirm: 'Discard invoice',
  customAmount: 'Enter an amount',
  ago: { now: 'just now', m: '{n}m', h: '{n}h', yesterday: '1d', d: '{n}d' },
}

export type Lang = 'th' | 'en'
const DICTS: Record<Lang, Dict> = { th, en }
const KEY = 'nampu.lang'

interface I18n {
  lang: Lang
  t: Dict
  setLang: (l: Lang) => void
  toggleLang: () => void
  /** Replace {name} placeholders. */
  f: (template: string, vars: Record<string, string | number>) => string
}

const Ctx = createContext<I18n | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    try {
      const v = localStorage.getItem(KEY)
      if (v === 'th' || v === 'en') return v
    } catch {
      // ignore
    }
    return 'th'
  })
  useEffect(() => {
    document.documentElement.lang = lang
    try {
      localStorage.setItem(KEY, lang)
    } catch {
      // ignore
    }
  }, [lang])
  const f = useCallback((template: string, vars: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? '')), [])
  const value = useMemo<I18n>(
    () => ({ lang, t: DICTS[lang], setLang: setLangState, toggleLang: () => setLangState((l) => (l === 'th' ? 'en' : 'th')), f }),
    [lang, f],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useI18n(): I18n {
  const v = useContext(Ctx)
  if (!v) throw new Error('useI18n outside I18nProvider')
  return v
}
