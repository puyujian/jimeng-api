<script setup lang="ts">
interface Props {
  aspectRatio?: '1:1' | '4:3' | '16:9' | '3:4' | '9:16'
  rounded?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  aspectRatio: '1:1',
  rounded: true
})

const aspectRatioClasses = {
  '1:1': 'aspect-square',
  '4:3': 'aspect-[4/3]',
  '16:9': 'aspect-video',
  '3:4': 'aspect-[3/4]',
  '9:16': 'aspect-[9/16]'
}
</script>

<template>
  <div
    :class="[
      'relative overflow-hidden bg-gray-200',
      aspectRatioClasses[aspectRatio],
      { 'rounded-lg': rounded }
    ]"
  >
    <div class="absolute inset-0 skeleton-shimmer" />
    
    <!-- Image icon placeholder -->
    <div class="absolute inset-0 flex items-center justify-center">
      <svg
        class="w-12 h-12 text-gray-300"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="1.5"
          d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
        />
      </svg>
    </div>
  </div>
</template>

<style scoped>
.skeleton-shimmer {
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.4) 50%,
    transparent 100%
  );
  animation: shimmer 1.5s infinite;
}



@keyframes shimmer {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(100%);
  }
}
</style>
