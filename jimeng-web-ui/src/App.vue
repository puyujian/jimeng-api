<script setup lang="ts">
import { RouterView } from 'vue-router'
import MainLayout from './layouts/MainLayout.vue'
import { ErrorBoundary } from './components/common'
</script>

<template>
  <MainLayout>
    <ErrorBoundary fallback-message="页面加载出错">
      <RouterView v-slot="{ Component, route }">
        <Transition
          name="page"
          mode="out-in"
          appear
        >
          <component :is="Component" :key="route.path" />
        </Transition>
      </RouterView>
    </ErrorBoundary>
  </MainLayout>
</template>

<style scoped>
/* Page transition animations */
.page-enter-active,
.page-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.page-enter-from {
  opacity: 0;
  transform: translateY(10px);
}

.page-leave-to {
  opacity: 0;
  transform: translateY(-10px);
}
</style>
