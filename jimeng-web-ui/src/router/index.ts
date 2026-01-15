import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    redirect: '/text-to-image'
  },
  {
    path: '/text-to-image',
    name: 'TextToImage',
    component: () => import('../views/TextToImageView.vue'),
    meta: { title: '文生图', requiresAuth: true }
  },
  {
    path: '/image-to-image',
    name: 'ImageToImage',
    component: () => import('../views/ImageToImageView.vue'),
    meta: { title: '图生图', requiresAuth: true }
  },
  {
    path: '/video-generate',
    name: 'VideoGenerate',
    component: () => import('../views/VideoGenerateView.vue'),
    meta: { title: '视频生成', requiresAuth: true }
  },
  {
    path: '/chat',
    name: 'Chat',
    component: () => import('../views/ChatView.vue'),
    meta: { title: '聊天', requiresAuth: true }
  },
  {
    path: '/history',
    name: 'History',
    component: () => import('../views/HistoryView.vue'),
    meta: { title: '历史记录', requiresAuth: true }
  },
  {
    path: '/settings',
    name: 'Settings',
    component: () => import('../views/SettingsView.vue'),
    meta: { title: '设置', requiresAuth: false }
  }
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes
})

// Navigation guard to check if settings are configured
router.beforeEach((to, _from, next) => {
  // Update document title
  const title = to.meta.title as string | undefined
  document.title = title ? `${title} - Jimeng Web UI` : 'Jimeng Web UI'

  // Check if route requires authentication (settings configured)
  if (to.meta.requiresAuth) {
    // We'll check settings in the component level via MainLayout
    // This allows the settings modal to appear on first visit
    next()
  } else {
    next()
  }
})

export default router
