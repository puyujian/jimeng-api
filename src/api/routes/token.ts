import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import { getTokenLiveStatus, getCredit, receiveCredit, tokenSplit } from '@/api/controllers/core.ts';
import SYSTEM_EX from '@/lib/consts/exceptions.ts';
import Exception from '@/lib/exceptions/Exception.ts';
import logger from '@/lib/logger.ts';
import { haochiAccountPoolService } from '@/haochi/index.ts';

export default {

    prefix: '/token',

    post: {

        '/check': async (request: Request) => {
            request
                .validate('body.token', _.isString)
            const live = await getTokenLiveStatus(request.body.token);
            return {
                live
            }
        },

        '/points': async (request: Request) => {
            if (!haochiAccountPoolService.hasCredential(request.headers))
                throw new Exception(SYSTEM_EX.SYSTEM_REQUEST_VALIDATION_ERROR, '缺少 Authorization 或 X-API-Key').setHTTPStatusCode(401);
            if (haochiAccountPoolService.isManagedApiKeyRequest(request.headers))
                return await haochiAccountPoolService.getManagedTokenPoints(request);
            request.validate('headers.authorization', _.isString)
            // refresh_token切分
            const tokens = tokenSplit(request.headers.authorization);
            const points = await Promise.all(tokens.map(async (token) => {
                return {
                    token,
                    points: await getCredit(token)
                }
            }))
            return points;
        },

        '/receive': async (request: Request) => {
            if (!haochiAccountPoolService.hasCredential(request.headers))
                throw new Exception(SYSTEM_EX.SYSTEM_REQUEST_VALIDATION_ERROR, '缺少 Authorization 或 X-API-Key').setHTTPStatusCode(401);
            if (haochiAccountPoolService.isManagedApiKeyRequest(request.headers))
                return await haochiAccountPoolService.receiveManagedTokenCredits(request);
            request.validate('headers.authorization', _.isString)
            // refresh_token切分
            const tokens = tokenSplit(request.headers.authorization);
            const credits = await Promise.all(tokens.map(async (token) => {
                const currentCredit = await getCredit(token);
                if (currentCredit.totalCredit <= 0) {
                    try {
                        await receiveCredit(token);
                        const updatedCredit = await getCredit(token);
                        return {
                            token,
                            credits: updatedCredit,
                            received: true
                        }
                    } catch (err) {
                        logger.warn('收取积分失败:', err);
                        return {
                            token,
                            credits: currentCredit,
                            received: false,
                            error: err.message
                        }
                    }
                }
                return {
                    token,
                    credits: currentCredit,
                    received: false
                }
            }))
            return credits;
        }

    }

}
