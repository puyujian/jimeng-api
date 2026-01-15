import Response from '@/lib/response/Response.ts';
import { SessionProvider } from '@/lib/SessionProvider.ts';
import logger from '@/lib/logger.ts';

export default {
  post: {
    '/v1/session/generate': async () => {
      try {
        logger.info('开始生成新的 Session ID...');
        
        const sessionId = await SessionProvider.generateNewSession();
        
        logger.info(`Session ID 生成成功: ${sessionId.substring(0, 10)}...`);
        
        return new Response({
          sessionId,
          message: 'Session ID 生成成功',
          timestamp: Date.now()
        });
      } catch (error: any) {
        logger.error(`Session ID 生成失败: ${error.message}`);
        
        return new Response({
          error: 'Session ID 生成失败',
          message: error.message || '未知错误',
          timestamp: Date.now()
        }, {
          statusCode: 500
        });
      }
    }
  }
};