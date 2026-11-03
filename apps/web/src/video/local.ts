const jobs = new Map<string, Promise<string>>();

/** Download one clip and keep a blob URL for the rest of the page session. */
export function localVideoUrl(remote: string): Promise<string> {
  let job = jobs.get(remote);
  if (!job) {
    job = fetch(remote).then(async (response) => {
      if (!response.ok) throw new Error(`${response.status} ${remote}`);
      const bytes = await response.arrayBuffer();
      return URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
    });
    jobs.set(remote, job);
  }
  return job;
}
