<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useHistoryStore } from '../stores/history.store'
import { BaseButton, BaseSelect, BaseModal } from '../components/common'
import { ImageGallery, VideoPlayer } from '../components/generation'
import type { HistoryItem } from '../types'

const router = useRouter()
const historyStore = useHistoryStore()

// Filter state
const filterType = ref<'all' | 'image' | 'video' | 'composition'>('all')

// Modal state
const showDetailModal = ref(false)
const selectedItem = ref<HistoryItem | null>(null)
const showDeleteConfirm = ref(false)
const itemToDelete = ref<string | null>(null)

// Filter options
const filterOptions = [
  { value: 'all', label: '全部' },
  { value: 'image', label: '文生图' },
  { value: 'composition', label: '图生图' },
  { value: 'video', label: '视频' }
]

// Computed
const filteredItems = computed(() => {
  if (filterType.value === 'all') {
    return historyStore.items
  }
  return historyStore.items.filter(item => item.type === filterType.value)
})

// Load history on mount
onMounted(() => {
  historyStore.loadFromStorage()
})

// Format date
function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

// Get type label
function getTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    image: '文生图',
    composition: '图生图',
    video: '视频'
  }
  return labels[type] || type
}

// Get type color
function getTypeColor(type: string): string {
  const colors: Record<string, string> = {
    image: 'bg-blue-100 text-blue-700',
    composition: 'bg-purple-100 text-purple-700',
    video: 'bg-green-100 text-green-700'
  }
  return colors[type] || 'bg-gray-100 text-gray-700'
}

// Open detail modal
function openDetail(item: HistoryItem) {
  selectedItem.value = item
  showDetailModal.value = true
}

// Close detail modal
function closeDetail() {
  showDetailModal.value = false
  selectedItem.value = null
}

// Use prompt - navigate to appropriate view with all parameters
function usePrompt(item: HistoryItem) {
  // 构建包含所有参数的 query
  const query: Record<string, string> = {
    prompt: item.prompt
  }
  
  // 添加参数到 query
  if (item.params) {
    Object.keys(item.params).forEach(key => {
      const value = item.params[key]
      if (value !== undefined && value !== null) {
        query[key] = String(value)
      }
    })
  }
  
  if (item.type === 'image') {
    router.push({ path: '/text-to-image', query })
  } else if (item.type === 'composition') {
    router.push({ path: '/image-to-image', query })
  } else if (item.type === 'video') {
    router.push({ path: '/video', query })
  }

  closeDetail()
}

// Confirm delete
function confirmDelete(id: string) {
  itemToDelete.value = id
  showDeleteConfirm.value = true
}

// Delete item
function deleteItem() {
  if (itemToDelete.value) {
    historyStore.removeItem(itemToDelete.value)
    itemToDelete.value = null
    showDeleteConfirm.value = false
    showDetailModal.value = false
    // Close detail modal if the deleted item was selected
    if (selectedItem.value?.id === itemToDelete.value) {
      closeDetail()
    }
  }
}

// Clear all history
function clearAllHistory() {
  historyStore.clearAll()
}
</script>

<template>
  <div class="flex flex-col">
    <!-- Header -->
    <div class="flex-shrink-0 flex items-center justify-between mb-6">
      <h1 class="text-xl font-bold text-gray-900">
        历史记录
      </h1>
      
      <div class="flex items-center gap-4">
        <!-- Filter -->
        <BaseSelect
          v-model="filterType"
          :options="filterOptions"
          class="w-32"
        />
        
        <!-- Clear All -->
        <BaseButton
          v-if="historyStore.items.length > 0"
          variant="outline"
          size="sm"
          @click="clearAllHistory"
        >
          清空全部
        </BaseButton>
      </div>
    </div>

    <!-- Empty State -->
    <div
      v-if="filteredItems.length === 0"
      class="flex-1 flex flex-col items-center justify-center text-center"
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
          d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
      <p class="text-gray-500">
        {{ filterType === 'all' ? '暂无历史记录' : '暂无该类型的历史记录' }}
      </p>
    </div>

    <!-- History Grid -->
    <div
      v-else
      class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"
    >
      <div
        v-for="item in filteredItems"
        :key="item.id"
        class="group bg-white rounded-xl shadow-sm overflow-hidden hover:shadow-md transition-shadow cursor-pointer"
        @click="openDetail(item)"
      >
        <!-- Thumbnail -->
        <div class="aspect-square relative bg-gray-100">
          <!-- 视频类型：优先显示缩略图，否则显示视频预览 -->
          <template v-if="item.type === 'video'">
            <video
              v-if="item.results[0]"
              :src="item.results[0]"
              class="w-full h-full object-cover"
              muted
              preload="metadata"
            />
            <div
              v-else
              class="w-full h-full flex items-center justify-center"
            >
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
                  d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
            </div>
          </template>
          <!-- 图片类型 -->
          <template v-else>
            <img
              v-if="item.thumbnail || item.results[0]"
              :src="item.thumbnail || item.results[0]"
              :alt="item.prompt"
              class="w-full h-full object-cover"
            />
            <div
              v-else
              class="w-full h-full flex items-center justify-center"
            >
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
          </template>
          
          <!-- Type Badge -->
          <span
            :class="[
              'absolute top-2 left-2 px-2 py-0.5 text-xs font-medium rounded',
              getTypeColor(item.type)
            ]"
          >
            {{ getTypeLabel(item.type) }}
          </span>
          
          <!-- Video indicator -->
          <div
            v-if="item.type === 'video'"
            class="absolute inset-0 flex items-center justify-center"
          >
            <div class="w-12 h-12 bg-black/50 rounded-full flex items-center justify-center">
              <svg class="w-6 h-6 text-white ml-1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd" />
              </svg>
            </div>
          </div>
          
          <!-- Hover overlay -->
          <div class="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
        </div>
        
        <!-- Info -->
        <div class="p-3">
          <p class="text-sm text-gray-900 line-clamp-2">
            {{ item.prompt }}
          </p>
          <p class="text-xs text-gray-400 mt-1">
            {{ formatDate(item.createdAt) }}
          </p>
        </div>
      </div>
    </div>

    <!-- Detail Modal -->
    <BaseModal
      v-model="showDetailModal"
      :title="selectedItem ? getTypeLabel(selectedItem.type) + ' 详情' : ''"
      size="xl"
    >
      <div v-if="selectedItem" class="space-y-4">
        <!-- Prompt -->
        <div>
          <h4 class="text-sm font-medium text-gray-700 mb-1">提示词</h4>
          <p class="text-gray-900 bg-gray-50 rounded-lg p-3">
            {{ selectedItem.prompt }}
          </p>
        </div>
        
        <!-- Parameters -->
        <div>
          <h4 class="text-sm font-medium text-gray-700 mb-1">参数</h4>
          <div class="flex flex-wrap gap-2">
            <span
              v-for="(value, key) in selectedItem.params"
              :key="key"
              class="px-2 py-1 text-xs bg-gray-100 rounded"
            >
              {{ key }}: {{ value }}
            </span>
          </div>
        </div>
        
        <!-- Results -->
        <div>
          <h4 class="text-sm font-medium text-gray-700 mb-2">结果</h4>
          
          <!-- Video -->
          <VideoPlayer
            v-if="selectedItem.type === 'video' && selectedItem.results[0]"
            :src="selectedItem.results[0]"
          />
          
          <!-- Images -->
          <ImageGallery
            v-else
            :images="selectedItem.results"
            :columns="2"
          />
        </div>
        
        <!-- Date -->
        <p class="text-xs text-gray-400">
          创建于 {{ formatDate(selectedItem.createdAt) }}
        </p>
      </div>
      
      <template #footer>
        <div class="flex justify-between">
          <BaseButton
            variant="danger"
            @click="confirmDelete(selectedItem!.id)"
          >
            删除
          </BaseButton>
          <BaseButton
            variant="primary"
            @click="usePrompt(selectedItem!)"
          >
            使用此提示词
          </BaseButton>
        </div>
      </template>
    </BaseModal>

    <!-- Delete Confirmation Modal -->
    <Teleport to="body">
      <Transition name="modal">
        <div
          v-if="showDeleteConfirm"
          class="fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          <div class="absolute inset-0 bg-black/50" @click="showDeleteConfirm = false" />
          <div class="relative bg-white rounded-xl p-6 max-w-sm w-full shadow-xl">
            <h3 class="text-lg font-semibold text-gray-900 mb-2">
              确认删除
            </h3>
            <p class="text-gray-600 mb-6">
              确定要删除这条历史记录吗？此操作无法撤销。
            </p>
            <div class="flex justify-end gap-3">
              <BaseButton variant="outline" @click="showDeleteConfirm = false">
                取消
              </BaseButton>
              <BaseButton variant="danger" @click="deleteItem">
                确认删除
              </BaseButton>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s ease;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.line-clamp-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
