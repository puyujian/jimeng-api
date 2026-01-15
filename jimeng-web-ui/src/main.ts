import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import App from './App.vue'
import './style.css'

const app = createApp(App)

app.use(createPinia())
app.use(router)

// Global error handler
app.config.errorHandler = (err, instance, info) => {
  // Log error to console in development
  console.error('Global error:', err)
  console.error('Component:', instance)
  console.error('Error info:', info)
  
  // In production, you could send this to an error tracking service
  // e.g., Sentry, LogRocket, etc.
}

// Handle unhandled promise rejections
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason)
  // Prevent the default browser behavior (logging to console)
  event.preventDefault()
})

app.mount('#app')
