<script setup lang="ts">
import { ref } from 'vue'

interface Props {
  images: string[]
  loading?: boolean
  columns?: 2 | 3 | 4
}

const props = withDefaults(defineProps<Props>(), {
  images: () => [],
  loading: false,
  columns: 2
})

const emit = defineEmits<{
  download: [url: string]
  copyUrl: [url: string]
}>()

const enlargedImage = ref<string | null>(null)
const copiedUrl = ref<string | null>(null)

const columnClasses = {
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4'
}

const openEnlarged = (url: string) => {
  enlargedImage.value = url
}

const closeEnlarged = () => {
  enlargedImage.value = null
}

const handleDownload = async (url: string) => {
  emit('download', url)
  
  try {
    const response = await fetch(url)
    const blob = await response.blob()
    const blobUrl = URL.createObjectURL(blob)
    
    const link = document.createElement('a')
    link.href = blobUrl
    link.download = `image-${Date.now()}.png`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    
    URL.revokeObjectURL(blobUrl)
  } catch (error) {
    console.error('Download failed:', error)
  }
}

const handleCopyUrl = async (url: string) => {
  emit('copyUrl', url)
  
  try {
    await navigator.clipboard.writeText(url)
    copiedUrl.value = url
    setTimeout(() => {
      copiedUrl.value = null
    }, 2000)
  } catch (error) {
    console.error('Copy failed:', error)
  }
}
</script>

<template>
  <div class="w-full">
    <!-- Loading State -->
    <div v-if="loading" :class="['grid gap-4', columnClasses[columns]]">
      <div
        v-for="i in 4"
        :key="i"
        class="aspect-square bg-gray-200 rounded-lg animate-pulse"
      />
    </div>

    <!-- Empty State -->
    <div
      v-else-if="images.length === 0"
      class="flex flex-col items-center justify-center py-12 text-center"
    >
      <svg
        class="w-16 h-16 text-gray-300 mb-4"
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
      <p class="text-gray-500">暂无生成的图片</p>
    </div>

    <!-- Image Grid -->
    <div v-else :class="['grid gap-4', columnClasses[columns]]">
      <div
        v-for="(url, index) in images"
        :key="index"
        class="group relative aspect-square rounded-lg overflow-hidden bg-gray-100 shadow-sm hover:shadow-md transition-shadow"
      >
        <img
          :src="url"
          :alt="`Generated image ${index + 1}`"
          class="w-full h-full object-cover cursor-pointer transition-transform duration-300 group-hover:scale-105"
          @click="openEnlarged(url)"
        />
        
        <!-- Action Buttons Overlay -->
        <div class="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/70 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
          <div class="flex justify-center gap-2">
            <!-- Download Button -->
            <button
              type="button"
              class="p-2 bg-white/90 text-gray-700 rounded-lg hover:bg-white transition-colors"
              title="下载图片"
              @click.stop="handleDownload(url)"
            >
              <svg class="w-5 h-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clip-rule="evenodd" />
              </svg>
            </button>
            
            <!-- Copy URL Button -->
            <button
              type="button"
              :class="[
                'p-2 rounded-lg transition-colors',
                copiedUrl === url
                  ? 'bg-green-500 text-white'
                  : 'bg-white/90 text-gray-700 hover:bg-white'
              ]"
              :title="copiedUrl === url ? '已复制' : '复制链接'"
              @click.stop="handleCopyUrl(url)"
            >
              <svg v-if="copiedUrl === url" class="w-5 h-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
              </svg>
              <svg v-else class="w-5 h-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
                <path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z" />
              </svg>
            </button>
            
            <!-- Enlarge Button -->
            <button
              type="button"
              class="p-2 bg-white/90 text-gray-700 rounded-lg hover:bg-white transition-colors"
              title="放大查看"
              @click.stop="openEnlarged(url)"
            >
              <svg class="w-5 h-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v6m3-3H7" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Enlarged Image Modal -->
    <Teleport to="body">
      <Transition name="fade">
        <div
          v-if="enlargedImage"
          class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90"
          @click="closeEnlarged"
        >
          <!-- Close Button -->
          <button
            type="button"
            class="absolute top-4 right-4 p-2 text-white/80 hover:text-white transition-colors"
            @click="closeEnlarged"
          >
            <svg class="w-8 h-8" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
            </svg>
          </button>
          
          <!-- Image -->
          <img
            :src="enlargedImage"
            alt="Enlarged image"
            class="max-w-full max-h-full object-contain rounded-lg"
            @click.stop
          />
          
          <!-- Action Buttons -->
          <div class="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-3">
            <button
              type="button"
              class="flex items-center gap-2 px-4 py-2 bg-white text-gray-700 rounded-lg hover:bg-gray-100 transition-colors"
              @click.stop="handleDownload(enlargedImage!)"
            >
              <svg class="w-5 h-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" clip-rule="evenodd" />
              </svg>
              下载
            </button>
            <button
              type="button"
              :class="[
                'flex items-center gap-2 px-4 py-2 rounded-lg transition-colors',
                copiedUrl === enlargedImage
                  ? 'bg-green-500 text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-100'
              ]"
              @click.stop="handleCopyUrl(enlargedImage!)"
            >
              <svg v-if="copiedUrl === enlargedImage" class="w-5 h-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
              </svg>
              <svg v-else class="w-5 h-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
                <path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z" />
              </svg>
              {{ copiedUrl === enlargedImage ? '已复制' : '复制链接' }}
            </button>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
