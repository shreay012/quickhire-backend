import { Router } from 'express';
import authRoutes from './modules/auth/auth.routes.js';
import userRoutes from './modules/user/user.routes.js';
import serviceRoutes from './modules/service/service.routes.js';
import bookingRoutes from './modules/booking/booking.routes.js';
import jobRoutes from './modules/job/job.routes.js';
import paymentRoutes from './modules/payment/payment.routes.js';
import chatRoutes from './modules/chat/chat.routes.js';
import notificationRoutes from './modules/notification/notification.routes.js';
import adminRoutes from './modules/admin/admin.routes.js';
import ticketRoutes from './modules/ticket/ticket.routes.js';
import miscRoutes from './modules/misc/misc.routes.js';
import pmRoutes from './modules/pm/pm.routes.js';
import resourceRoutes from './modules/resource/resource.routes.js';
import dashboardRoutes from './modules/dashboard/dashboard.routes.js';
import cmsRoutes from './modules/cms/cms.routes.js';
import opsRoutes from './modules/ops/ops.routes.js';
import poolRoutes from './modules/pool/pool.routes.js';
import scorecardRoutes from './modules/scorecard/scorecard.routes.js';
import bulkRoutes from './modules/bulk/bulk.routes.js';
import adminOpsRoutes from './modules/admin/adminOps.routes.js';
import promoRoutes from './modules/promo/promo.routes.js';
import referralRoutes from './modules/promo/referral.routes.js';
import cmsExpandedRoutes from './modules/cms/cmsExpanded.routes.js';
import cmsPagesRoutes from './modules/cms/pages.routes.js';
import cmsMediaRoutes from './modules/cms/media.routes.js';
import cmsAiRoutes from './modules/cms/ai.routes.js';
import cmsEventsRoutes from './modules/cms/events.routes.js';
import cmsOverlayRoutes from './modules/cms/overlay.routes.js';
import experimentsRoutes from './modules/cms/experiments.routes.js';
import flagsRoutes from './modules/flags/flags.routes.js';
import i18nRoutes from './modules/i18n/i18n.routes.js';
import geoPricingRoutes from './modules/i18n/geo-pricing.routes.js';
import analyticsRoutes from './modules/analytics/analytics.routes.js';
import reviewRoutes from './modules/review/review.routes.js';
import customerRoutes from './modules/customer/customer.routes.js';
import chatbotRoutes from './modules/chatbot/chatbot.routes.js';
import searchRoutes from './modules/search/search.routes.js';
import legalRoutes from './modules/legal/legal.routes.js';
import blogRoutes from './modules/blog/blog.routes.js';
import seoRoutes from './modules/seo/seo.routes.js';
import guestSessionRoutes from './modules/guest-session/guest-session.routes.js';

const r = Router();
r.use('/auth', authRoutes);
r.use('/user', userRoutes);
r.use('/services', serviceRoutes);
r.use('/bookings', bookingRoutes);
r.use('/customer/bookings', bookingRoutes); // alias used by frontend
r.use('/bookingHistories', bookingRoutes);
r.use('/jobs', jobRoutes);
r.use('/payments', paymentRoutes);
r.use('/chat', chatRoutes);
r.use('/notifications', notificationRoutes);
r.use('/admin', adminRoutes);
r.use('/tickets', ticketRoutes);
r.use('/pm', pmRoutes);
r.use('/resource', resourceRoutes);
r.use('/dashboard', dashboardRoutes);
r.use('/ticket-messages', ticketRoutes);
r.use('/miscellaneous', miscRoutes);
r.use('/cms', cmsRoutes);
r.use('/ops', opsRoutes);
r.use('/pool', poolRoutes);
r.use('/scorecards', scorecardRoutes);
r.use('/bulk', bulkRoutes);
r.use('/admin-ops', adminOpsRoutes);
r.use('/promo', promoRoutes);
r.use('/referral', referralRoutes);
r.use('/cms-x', cmsExpandedRoutes);
r.use('/cms-pages', cmsPagesRoutes); // Phase 3 — dynamic page builder
r.use('/cms-media', cmsMediaRoutes); // Phase 3 — central media library
r.use('/cms-ai',    cmsAiRoutes);    // Phase 5.2 — AI copy suggestions
r.use('/cms-events', cmsEventsRoutes); // Phase 5.3 — interaction events / CTR
r.use('/cms-overlay', cmsOverlayRoutes); // Phase 6 — translations + lists overlay reads
r.use('/experiments', experimentsRoutes); // Phase 7.1 — A/B testing
r.use('/flags', flagsRoutes);
r.use('/i18n', i18nRoutes);
r.use('/geo-pricing', geoPricingRoutes);
r.use('/analytics', analyticsRoutes);
r.use('/reviews', reviewRoutes);
r.use('/customer', customerRoutes);
r.use('/chatbot', chatbotRoutes);
r.use('/search', searchRoutes);
r.use('/legal', legalRoutes);
r.use('/blog', blogRoutes);
r.use('/admin/seo', seoRoutes);
r.use('/guest-session', guestSessionRoutes);

export default r;
