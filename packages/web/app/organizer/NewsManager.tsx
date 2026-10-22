'use client';

import { useCallback, useEffect, useState } from 'react';
import { organizerNews, type AdminNewsPostDto } from '../../lib/api';
import { errorText } from '../../lib/client';

interface Notice {
  readonly kind: 'success' | 'error';
  readonly text: string;
}

function formatInstant(iso: string | null | undefined): string {
  if (!iso) return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(iso);
  return match ? `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]} UTC` : iso;
}

const INPUT_CLASS =
  'w-full rounded-lg border border-[var(--border-control)] bg-[var(--surface-subtle)] px-3 py-2 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--action)] transition-colors';
const TEXTAREA_CLASS =
  'w-full rounded-lg border border-[var(--border-control)] bg-[var(--surface-subtle)] px-3 py-2 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--action)] transition-colors font-mono';

function stateBadge(state: AdminNewsPostDto['state']) {
  switch (state) {
    case 'PUBLISHED':
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold font-mono uppercase tracking-wider bg-[rgba(0,245,212,0.12)] text-[var(--success-text)] border border-[rgba(0,245,212,0.3)]">
          <span className="w-1.5 h-1.5 rounded-full bg-current" />
          Đã xuất bản
        </span>
      );
    case 'DRAFT':
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold font-mono uppercase tracking-wider bg-[rgba(245,165,36,0.12)] text-[var(--warning-text)] border border-[rgba(245,165,36,0.3)]">
          <span className="w-1.5 h-1.5 rounded-full bg-current" />
          Bản nháp
        </span>
      );
    case 'ARCHIVED':
      return (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold font-mono uppercase tracking-wider bg-[var(--surface-subtle)] text-[var(--text-faint)] border border-[var(--border-subtle)]">
          <span className="w-1.5 h-1.5 rounded-full bg-current" />
          Đã lưu trữ
        </span>
      );
  }
}

export function NewsManager({ className }: { readonly className?: string }) {
  const [posts, setPosts] = useState<readonly AdminNewsPostDto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  // Create form state
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [newSummary, setNewSummary] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newPublishNow, setNewPublishNow] = useState(false);

  // Edit form state
  const [editingPost, setEditingPost] = useState<AdminNewsPostDto | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editSummary, setEditSummary] = useState('');
  const [editContent, setEditContent] = useState('');

  const loadPosts = useCallback(async () => {
    setLoading(true);
    const result = await organizerNews.list();
    setLoading(false);
    if (!result.ok || !result.data) {
      setNotice({ kind: 'error', text: errorText(result, 'Không thể tải danh sách bản tin.') });
      return;
    }
    setPosts(result.data.posts);
  }, []);

  useEffect(() => {
    void loadPosts();
  }, [loadPosts]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) {
      setNotice({ kind: 'error', text: 'Tiêu đề bản tin không được để trống.' });
      return;
    }
    if (!newSummary.trim()) {
      setNotice({ kind: 'error', text: 'Tóm tắt bản tin không được để trống.' });
      return;
    }
    if (!newContent.trim()) {
      setNotice({ kind: 'error', text: 'Nội dung bản tin không được để trống.' });
      return;
    }

    setPendingAction('create');
    const result = await organizerNews.create({
      title: newTitle.trim(),
      slug: newSlug.trim() || undefined,
      summary: newSummary.trim(),
      content: newContent.trim(),
      publishNow: newPublishNow,
    });
    setPendingAction(null);

    if (!result.ok || !result.data) {
      setNotice({ kind: 'error', text: errorText(result, 'Không thể tạo bản tin mới.') });
      return;
    }

    setNotice({
      kind: 'success',
      text: `Đã tạo bản tin "${result.data.post.title}" (${result.data.post.state === 'PUBLISHED' ? 'Đã xuất bản' : 'Bản nháp'}).`,
    });
    setNewTitle('');
    setNewSlug('');
    setNewSummary('');
    setNewContent('');
    setNewPublishNow(false);
    setShowCreateForm(false);
    await loadPosts();
  }

  function startEdit(post: AdminNewsPostDto) {
    setEditingPost(post);
    setEditTitle(post.title);
    setEditSummary(post.summary);
    setEditContent(post.content);
    setNotice(null);
  }

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    if (!editingPost) return;
    if (!editTitle.trim()) {
      setNotice({ kind: 'error', text: 'Tiêu đề bản tin không được để trống.' });
      return;
    }
    if (!editSummary.trim()) {
      setNotice({ kind: 'error', text: 'Tóm tắt bản tin không được để trống.' });
      return;
    }
    if (!editContent.trim()) {
      setNotice({ kind: 'error', text: 'Nội dung bản tin không được để trống.' });
      return;
    }

    setPendingAction(`update-${editingPost.id}`);
    const result = await organizerNews.update(editingPost.id, {
      title: editTitle.trim(),
      summary: editSummary.trim(),
      content: editContent.trim(),
    });
    setPendingAction(null);

    if (!result.ok || !result.data) {
      setNotice({ kind: 'error', text: errorText(result, 'Không thể cập nhật bản tin.') });
      return;
    }

    setNotice({ kind: 'success', text: `Đã cập nhật bản tin "${result.data.post.title}".` });
    setEditingPost(null);
    await loadPosts();
  }

  async function handlePublish(post: AdminNewsPostDto) {
    setPendingAction(`publish-${post.id}`);
    const result = await organizerNews.publish(post.id);
    setPendingAction(null);

    if (!result.ok || !result.data) {
      setNotice({ kind: 'error', text: errorText(result, 'Không thể xuất bản bản tin.') });
      return;
    }

    setNotice({ kind: 'success', text: `Đã xuất bản thành công bản tin "${result.data.post.title}".` });
    await loadPosts();
  }

  async function handleArchive(post: AdminNewsPostDto) {
    if (!confirm(`Bạn có chắc chắn muốn lưu trữ bản tin "${post.title}"?`)) return;

    setPendingAction(`archive-${post.id}`);
    const result = await organizerNews.archive(post.id);
    setPendingAction(null);

    if (!result.ok || !result.data) {
      setNotice({ kind: 'error', text: errorText(result, 'Không thể lưu trữ bản tin.') });
      return;
    }

    setNotice({ kind: 'success', text: `Đã lưu trữ bản tin "${result.data.post.title}".` });
    await loadPosts();
  }

  return (
    <div className={`space-y-6 ${className ?? ''}`}>
      {/* Header and Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[var(--border-subtle)] pb-4">
        <div>
          <h2 className="text-lg font-bold text-[var(--text-primary)]">Quản lý Bản tin & Thông báo</h2>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">
            Đăng thông báo, tin tức sự kiện giải đấu và cập nhật hệ thống cho người dùng.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void loadPosts()}
            disabled={loading}
            className="vct-btn-secondary !py-1.5 !px-3 !text-xs !rounded-lg"
          >
            {loading ? 'Đang tải...' : 'Làm mới'}
          </button>
          <button
            type="button"
            onClick={() => {
              setShowCreateForm(!showCreateForm);
              setEditingPost(null);
              setNotice(null);
            }}
            className="vct-btn-primary !py-1.5 !px-3.5 !text-xs !rounded-lg"
          >
            {showCreateForm ? 'Đóng form' : '+ Tạo bản tin mới'}
          </button>
        </div>
      </div>

      {/* Notice alert */}
      {notice ? (
        <div
          role="status"
          className={`p-3 rounded-lg text-xs flex items-center justify-between border ${
            notice.kind === 'success'
              ? 'bg-[rgba(0,245,212,0.08)] border-[rgba(0,245,212,0.3)] text-[var(--success-text)]'
              : 'bg-[rgba(255,70,85,0.08)] border-[rgba(255,70,85,0.3)] text-[var(--danger-text)]'
          }`}
        >
          <span>{notice.text}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-[var(--text-faint)] hover:text-[var(--text-primary)] ml-2 text-sm"
          >
            ×
          </button>
        </div>
      ) : null}

      {/* Create Post Form */}
      {showCreateForm ? (
        <form
          onSubmit={(e) => void handleCreate(e)}
          className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] p-5 space-y-4 shadow-sm"
        >
          <h3 className="text-sm font-bold text-[var(--text-primary)] border-b border-[var(--border-subtle)] pb-2">
            Tạo bản tin mới
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-[var(--text-secondary)]">
                Tiêu đề <span className="text-[var(--action)]">*</span>
              </label>
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Ví dụ: Khởi tranh Vòng bảng OanTuTi UET 2026"
                className={INPUT_CLASS}
                required
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-[var(--text-secondary)]">
                Đường dẫn slug (tùy chọn, để trống sẽ tự tạo)
              </label>
              <input
                type="text"
                value={newSlug}
                onChange={(e) => setNewSlug(e.target.value)}
                placeholder="khoi-tranh-vong-bang-2026"
                className={INPUT_CLASS}
              />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-[var(--text-secondary)]">
              Tóm tắt ngắn <span className="text-[var(--action)]">*</span>
            </label>
            <textarea
              rows={2}
              value={newSummary}
              onChange={(e) => setNewSummary(e.target.value)}
              placeholder="Tóm tắt ngắn gọn nội dung hiển thị ở danh sách tin trang chủ..."
              className={INPUT_CLASS}
              required
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-[var(--text-secondary)]">
              Nội dung đầy đủ (hỗ trợ xuống dòng, định dạng đoạn văn) <span className="text-[var(--action)]">*</span>
            </label>
            <textarea
              rows={8}
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              placeholder="Soạn nội dung chi tiết của bản tin tại đây..."
              className={TEXTAREA_CLASS}
              required
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <input
              type="checkbox"
              id="publishNow"
              checked={newPublishNow}
              onChange={(e) => setNewPublishNow(e.target.checked)}
              className="rounded border-[var(--border-control)] bg-[var(--surface-subtle)] text-[var(--action)] focus:ring-[var(--action)]"
            />
            <label htmlFor="publishNow" className="text-xs font-medium text-[var(--text-primary)] cursor-pointer">
              Xuất bản ngay lập tức (hiển thị công khai tới người dùng)
            </label>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--border-subtle)]">
            <button
              type="button"
              onClick={() => setShowCreateForm(false)}
              className="vct-btn-secondary !py-2 !px-4 !text-xs !rounded-lg"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={pendingAction === 'create'}
              className="vct-btn-primary !py-2 !px-5 !text-xs !rounded-lg"
            >
              {pendingAction === 'create' ? 'Đang tạo...' : 'Lưu bản tin'}
            </button>
          </div>
        </form>
      ) : null}

      {/* Edit Post Modal / Form */}
      {editingPost ? (
        <form
          onSubmit={(e) => void handleUpdate(e)}
          className="rounded-xl border border-[var(--action)]/40 bg-[var(--surface)] p-5 space-y-4 shadow-md"
        >
          <div className="flex items-center justify-between border-b border-[var(--border-subtle)] pb-2">
            <div>
              <h3 className="text-sm font-bold text-[var(--text-primary)]">
                Chỉnh sửa bản tin: <span className="text-[var(--action)] font-mono text-xs">{editingPost.slug}</span>
              </h3>
              <p className="text-[11px] text-[var(--text-secondary)] mt-0.5">
                Trạng thái hiện tại: {editingPost.state}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setEditingPost(null)}
              className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              Đóng form
            </button>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-[var(--text-secondary)]">Tiêu đề</label>
            <input
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className={INPUT_CLASS}
              required
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-[var(--text-secondary)]">Tóm tắt ngắn</label>
            <textarea
              rows={2}
              value={editSummary}
              onChange={(e) => setEditSummary(e.target.value)}
              className={INPUT_CLASS}
              required
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-[var(--text-secondary)]">Nội dung đầy đủ</label>
            <textarea
              rows={8}
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className={TEXTAREA_CLASS}
              required
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--border-subtle)]">
            <button
              type="button"
              onClick={() => setEditingPost(null)}
              className="vct-btn-secondary !py-2 !px-4 !text-xs !rounded-lg"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={pendingAction === `update-${editingPost.id}`}
              className="vct-btn-primary !py-2 !px-5 !text-xs !rounded-lg"
            >
              {pendingAction === `update-${editingPost.id}` ? 'Đang lưu...' : 'Cập nhật bản tin'}
            </button>
          </div>
        </form>
      ) : null}

      {/* Posts Table / List */}
      <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface)] overflow-hidden shadow-sm">
        <div className="p-4 border-b border-[var(--border-subtle)] flex items-center justify-between">
          <h3 className="text-sm font-bold text-[var(--text-primary)]">
            Danh sách bài viết {posts ? `(${posts.length})` : ''}
          </h3>
        </div>

        {posts === null && loading ? (
          <div className="p-8 text-center text-xs text-[var(--text-secondary)] font-mono">
            Đang tải dữ liệu bản tin...
          </div>
        ) : null}

        {posts !== null && posts.length === 0 ? (
          <div className="p-8 text-center text-xs text-[var(--text-secondary)]">
            Chưa có bài viết nào. Hãy bấm "+ Tạo bản tin mới" để bắt đầu.
          </div>
        ) : null}

        {posts !== null && posts.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-[var(--border-subtle)] bg-[var(--surface-subtle)] text-[var(--text-secondary)] font-mono text-[11px]">
                  <th className="py-2.5 px-4 font-semibold">Tiêu đề & Tóm tắt</th>
                  <th className="py-2.5 px-4 font-semibold">Trạng thái</th>
                  <th className="py-2.5 px-4 font-semibold">Tác giả</th>
                  <th className="py-2.5 px-4 font-semibold">Thời gian</th>
                  <th className="py-2.5 px-4 font-semibold text-right">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {posts.map((post) => (
                  <tr key={post.id} className="hover:bg-[var(--surface-subtle)]/50 transition-colors">
                    <td className="py-3 px-4 max-w-sm">
                      <div className="font-semibold text-[var(--text-primary)] truncate">{post.title}</div>
                      <div className="font-mono text-[10px] text-[var(--text-faint)] truncate mt-0.5">
                        slug: /{post.slug}
                      </div>
                      <p className="text-[11px] text-[var(--text-secondary)] line-clamp-1 mt-1">
                        {post.summary}
                      </p>
                    </td>
                    <td className="py-3 px-4 shrink-0 whitespace-nowrap">
                      {stateBadge(post.state)}
                    </td>
                    <td className="py-3 px-4 font-mono text-[11px] text-[var(--text-secondary)] shrink-0 whitespace-nowrap">
                      {post.authorDisplayName || 'ADMIN'}
                    </td>
                    <td className="py-3 px-4 shrink-0 whitespace-nowrap text-[11px]">
                      <div className="text-[var(--text-primary)]">
                        {post.publishedAt ? formatInstant(post.publishedAt) : 'Chưa xuất bản'}
                      </div>
                      <div className="text-[10px] text-[var(--text-faint)] font-mono">
                        Tạo: {formatInstant(post.createdAt)}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right shrink-0 whitespace-nowrap space-x-1.5">
                      <button
                        type="button"
                        onClick={() => startEdit(post)}
                        className="vct-btn-secondary !py-1 !px-2.5 !text-[11px] !rounded-md"
                      >
                        Sửa
                      </button>
                      {post.state === 'DRAFT' ? (
                        <button
                          type="button"
                          onClick={() => void handlePublish(post)}
                          disabled={pendingAction === `publish-${post.id}`}
                          className="vct-btn-primary !py-1 !px-2.5 !text-[11px] !rounded-md"
                        >
                          {pendingAction === `publish-${post.id}` ? 'Đang xuất bản...' : 'Xuất bản'}
                        </button>
                      ) : null}
                      {post.state !== 'ARCHIVED' ? (
                        <button
                          type="button"
                          onClick={() => void handleArchive(post)}
                          disabled={pendingAction === `archive-${post.id}`}
                          className="px-2.5 py-1 text-[11px] font-semibold rounded-md border border-[var(--border-control)] text-[var(--danger-text)] hover:bg-[var(--danger-tint)] transition-colors disabled:opacity-60"
                        >
                          {pendingAction === `archive-${post.id}` ? 'Đang lưu...' : 'Lưu trữ'}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default NewsManager;
