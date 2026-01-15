import { defineStore } from 'pinia'
import { ref } from 'vue'
import { apiService } from '../services/api.service'

export interface CreditInfo {
  giftCredit: number
  purchaseCredit: number
  vipCredit: number
  totalCredit: number
}

export const useCreditStore = defineStore('credit', () => {
  // State
  const creditInfo = ref<CreditInfo | null>(null)
  const isLoading = ref(false)
  const error = ref<string | null>(null)
  const lastUpdated = ref<number | null>(null)

  // Actions
  async function fetchCredit(): Promise<void> {
    isLoading.value = true
    error.value = null

    try {
      const data = await apiService.getCredit()
      creditInfo.value = data
      lastUpdated.value = Date.now()
    } catch (err: any) {
      error.value = err.message || '获取积分失败'
      console.error('Failed to fetch credit:', err)
    } finally {
      isLoading.value = false
    }
  }

  function clearCredit(): void {
    creditInfo.value = null
    error.value = null
    lastUpdated.value = null
  }

  return {
    creditInfo,
    isLoading,
    error,
    lastUpdated,
    fetchCredit,
    clearCredit,
  }
})
