import { Injectable } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import {appendCdnDomain, cdnReplaceDomain, getDownloadId, getTableWithPrefix} from '../../helper';
import { unserialize } from 'php-serialize';
import { As3cfItemsEntity } from './../../entities/as3cf_items.entity';
import { PostMetaEntity } from './../../entities/post_meta.entity';
import { PostEntity } from './../../entities/post.entity';
import { IFVideoLink } from './../../types/data.type';
import {TermRelationShipsBasicEntity} from "../../entities/term_relationships_basic.entity";
import {TermEntity} from "../../entities/term.entity";
import {Url} from "../../types";

@Injectable()
export class CommonService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectRepository(As3cfItemsEntity)
    private readonly as3cfItemRepository: Repository<As3cfItemsEntity>,
    @InjectRepository(PostMetaEntity)
    private readonly postMetaRepository: Repository<PostMetaEntity>,

    @InjectRepository(PostEntity)
    private readonly postRepository: Repository<PostEntity>,

    @InjectRepository(TermRelationShipsBasicEntity)
    private readonly termRelationRepository: Repository<TermRelationShipsBasicEntity>
  ) {}

  async execQuery(query: string, params?: any): Promise<any> {
    return await this.dataSource.query(query, params);
  }

  async convert2CdnUrl(ids: number[]): Promise<any> {
    const rows = await this.as3cfItemRepository
      .createQueryBuilder('as3cf')
      .select(['as3cf.sourceId as sourceId, as3cf.path as sourcekey'])
      .where('as3cf.sourceId IN (:...sourceId)', { sourceId: ids })
      .getRawMany();

    const itemMap = {};
    //conver ary to obj
    rows.forEach((v: any) => {
      itemMap[v.sourceId] = appendCdnDomain(v.sourcekey);
    });

    const mIds = ids.filter((v) => !itemMap[v]);

    if (mIds.length) {
      const metaRows = await this.postMetaRepository
        .createQueryBuilder('postMeta')
        .select(['postMeta.postId as id', 'postMeta.metaValue as value'])
        .where('postMeta.metaKey = "amazonS3_info"')
        .andWhere('postMeta.postId IN (:mIds)', { mIds: mIds })
        .getRawMany();

      metaRows.forEach((v) => {
        const mv = unserialize(v.value);
        if (mv['key']) {
          itemMap[v.id] = appendCdnDomain(mv['key']);
        }
      });
    }

    return itemMap;
  }

  async loadVideosData(videoId: number): Promise<any> {
    const videoData: any = {id: videoId, four_k_paid_source: "", sd_source: ""};

    const videoFields: string[] = [
      'video',
      'smartphone_sample',
      'oculus_sample',
      'free_4k_streaming',
      'free_embed_video_5k',
      'original_free',
      'full_size_video_file_paid_sd',
      'smartphone_paid',
      'oculus_paid',
      'full_size_video_file_paid',
      'paid_4k_streaming',
      'original_paid',
      'paid_embed_video_5k',
      'full_size_video_file',
      'newts',
      'video_link',
      'vr_file_format',
      'vr_sd_file_format',
      'has_4k_download',
    ];

    //Load data for list fields
    const metaRows = await this.postMetaRepository.createQueryBuilder('pm')
        .select(['pm.meta_key as k', 'pm.meta_value as v'])
        .where('postId = :postId', {postId: videoId})
        .andWhere('pm.postMeta IN(:metaKeys)', {metaKeys: videoFields})
        .getRawMany();

    let fieldsMap: any = {}, metaValue: any | null = null;
    metaRows.forEach((row) => {
        fieldsMap[row.k] = row.v;
    });

    videoData.hd_file_format = fieldsMap.vr_file_format || "STEREO_180_LR";
    videoData.sd_file_format = fieldsMap.vr_sd_file_format || videoData.hd_file_format;

    if(!fieldsMap?.video) {
      if(!fieldsMap.video_link) {
        return null;
      }

      videoData.sd_source = cdnReplaceDomain(fieldsMap.video_link);
      videoData.sd_stream = videoData.sd_source;
    } else {
      const videoId = fieldsMap.video;
      const childVideos = await this.postRepository.createQueryBuilder('p')
          .innerJoin(PostMetaEntity, 'pm', 'pm.postId = p.id AND pm.metaKey = :metaKey', {metaKey: "amazonS3_info"})
          .where('p.postType = :postType', {postType: "attachment"})
          .andWhere('p.postParent = :parentId', {parentId: videoId})
          .select(['p.id', 'p.postTitle as title', 'pm.metaValue as s3Info'])
          .getRawMany();

      childVideos.forEach((row) => {
          if(row.title.indexOf('480p H.264') !== -1) {
            const s3Info = unserialize(row.s3Info);

            if (s3Info.key) {
              videoData.sd_source = cdnReplaceDomain(s3Info.key);
              videoData.sd_stream = videoData.sd_source;
            }
          }
      });

      //Free HD
      if(fieldsMap.smartphone_sample) {
        videoData.hd_source = await this.getDownloadUrl(fieldsMap.smartphone_sample);
        videoData.hd_streaming = videoData.hd_source;
      }

      //Paid SD
      if(fieldsMap.full_size_video_file_paid_sd) {
        videoData.sd_paid_source = await this.getS3MetaInfoKey(fieldsMap.full_size_video_file_paid_sd);
        videoData.sd_paid_stream = videoData.sd_paid_source;
      }

      //Paid HD
      if(fieldsMap.smartphone_paid) {
        videoData.hd_paid_source = await this.getDownloadUrl(fieldsMap.smartphone_paid);
        videoData.hd_paid_streaming = videoData.hd_paid_source;
      }

      //Free 4K
      if(fieldsMap.oculus_sample) {
        videoData.four_k_source = await this.getDownloadUrl(fieldsMap.oculus_sample);
        videoData.four_k_streaming = videoData.four_k_source;
      }

      //Paid 4K
      if(fieldsMap.oculus_paid) {
        videoData.four_k_paid_source = await this.getDownloadUrl(fieldsMap.oculus_paid);
        videoData.four_k_paid_streaming = videoData.four_k_paid_source;
      }

      //Free 5K
      if(fieldsMap.free_embed_video_5k) {
        videoData.five_k_streaming = await this.getS3MetaInfoKey(fieldsMap.free_embed_video_5k);
      }

      //Paid 5K
      if(fieldsMap.free_embed_video_5k) {
          videoData.five_k_paid_streaming = await this.getS3MetaInfoKey(fieldsMap.free_embed_video_5k);
      }

      //Free Original
      if(fieldsMap.original_free) {
        videoData.original_source = await this.getDownloadUrl(fieldsMap.original_free);
      }

      //Paid Original
      if(fieldsMap.original_paid) {
        videoData.original_paid_source = await this.getDownloadUrl(fieldsMap.original_paid);
      }

      //Check for newts
      if(fieldsMap.newts) {
        //Free HD link reload
        if(fieldsMap.full_size_video_file && !isNaN(Number(fieldsMap.smartphone_sample))) {
            videoData.hd_streaming = await this.getS3MetaInfoKey(fieldsMap.full_size_video_file);
        }

        //Paid HD link reload
        if(fieldsMap.full_size_video_file_paid && !isNaN(Number(fieldsMap.smartphone_paid))) {
            videoData.hd_paid_streaming = await this.getS3MetaInfoKey(fieldsMap.full_size_video_file_paid);
        }

        //Free 4k link reload
        if(fieldsMap.has_4k_download && fieldsMap.free_4k_streaming) {
            videoData.four_k_streaming = await this.getS3MetaInfoKey(fieldsMap.free_4k_streaming);
        }

        //Paid 4k link reload
        if(fieldsMap.has_4k_download && fieldsMap.paid_4k_streaming) {
            videoData.four_k_paid_streaming = await this.getS3MetaInfoKey(fieldsMap.paid_4k_streaming);
        }
      }
    }

    return videoData;
  }

  async buildVideoLinks(type: string, videoData: any, userLevel: number): Promise<IFVideoLink[]> {//User Level: 0: Non-Login, 1: Logged-in, 2: Premium
    const videoLinks: IFVideoLink[] = [];

    if(!videoData) {
      return videoLinks;
    }

    const types: any[] = [
      {quality: 'SD', f: 'sd', stream: 1, download: 1, ord: 5, ul: 0},
      {quality: 'HD', f: 'hd', stream: 1, download: 1, ord: 15, ul: 0},
      {quality: '4K', f: 'four_k', stream: 1, download: 1, ord: 45, ul: 1},
      {quality: '5K', f: 'five_k', stream: 1, download: 0, ord: 55, ul: 2},
    ];

    const maxQuality = await this.getVideoMaxQuality(videoData.id);

    if(maxQuality) {
      types.push({quality: `${maxQuality}K`, f: 'original', stream: 0, download: 1, ord: (maxQuality * 10) + 5, ul: 2});
    }

    const formatParts = videoData.hd_file_format.split('_');
    const projection = formatParts[1];
    const stereo = formatParts[2];
    const fieldMiddle = type === 'full' ? '_paid' : '';

    types.forEach((v) => {
        if(userLevel === 2) {
          if(v.stream && videoData[`${v.f}${fieldMiddle}_stream`]) {
              videoLinks.push({
                is_stream: true,
                is_download: false,
                url: videoData[`${v.f}${fieldMiddle}_stream`],
                unavailable_reason: null,
                projection: projection,
                stereo: stereo,
                quality_name: v.quality,
                quality_order: v.ord,
              });
          }

          if(v.download && videoData[`${v.f}${fieldMiddle}_source`]) {
            videoLinks.push({
              is_stream: false,
              is_download: true,
              url: videoData[`${v.f}${fieldMiddle}_source`],
              unavailable_reason: null,
              projection: projection,
              stereo: stereo,
              quality_name: v.quality,
              quality_order: v.ord,
            });
          }
        } else {
          if(v.stream) {
            videoLinks.push({
              is_stream: true,
              is_download: false,
              url: userLevel < v.ul || type === 'full' ? null : (videoData[`${v.f}${fieldMiddle}_stream`] || ""),
              unavailable_reason: (userLevel === 1 || type === 'full' ? 'premium' : 'login'),
              projection: projection,
              stereo: stereo,
              quality_name: v.quality,
              quality_order: v.ord,
            });
          }

          if(v.download) {
            videoLinks.push({
              is_stream: false,
              is_download: true,
              url: userLevel < v.ul || type === 'full' ? null : (videoData[`${v.f}${fieldMiddle}_source`] || ""),
              unavailable_reason: (userLevel === 1 || type === 'full' ? 'premium' : 'login'),
              projection: projection,
              stereo: stereo,
              quality_name: v.quality,
              quality_order: v.ord,
            });
          }
        }
    });

    return videoLinks;
  }

  async getVideoMaxQuality(videoId: number): Promise<number> {
    const rows: any[] = await this.termRelationRepository.createQueryBuilder('tr')
        .innerJoin(TermEntity, 't', 't.termId = tr.termTaxonomyId')
        .where('tr.objectId = :videoId', {videoId: videoId})
        .andWhere('LOWER(t.name) IN(:slugs)', {slugs: ['4k', '5k', '6k', '7k', '8k']})
        .orderBy('t.name', 'DESC')
        .select(['t.name'])
        .getRawMany();

    let maxQuality = 0;
    for(let i = 0; i < rows.length; i++) {
      const quality = Number(rows[i].name.toLowerCase().replace('k', ''));

      if(!isNaN(quality) && quality > maxQuality) {
        maxQuality = quality;
      }
    }

    return maxQuality;
  }

  async getDownloadUrl(downloadValue: string): Promise<any> {
    const isDownloadVersion = String(downloadValue).indexOf("download") !== -1;
    const downloadId = getDownloadId(downloadValue);
    let downloadUrl = "";

    if(!isDownloadVersion) {
        const metaValue: any = this.getPostMeta(downloadId, "_wp_attached_file");

        if(metaValue) {
          downloadUrl = cdnReplaceDomain(metaValue);
        }
    } else {
      const childs: any[] = await this.postRepository.createQueryBuilder('p')
          .innerJoin(PostMetaEntity, 'pm', 'pm.postId = p.id AND pm.metaKey = :metaKey', {metaKey: "_files"})
          .where('p.postType = :postType', {postType: "dlm_download_version"})
          .andWhere('p.postParent = :parentId', {parentId: downloadId})
          .select(['p.id', 'pm.metaValue as _files'])
          .getRawMany();

      childs.forEach((child) => {
          if(Array.isArray(child._files) && child._files.length) {
            downloadUrl = child._files[0];
          }
      });
    }

    return downloadUrl;
  }

  async getPostMeta(postId: number | string, metaKey: string): Promise<any> {
    const metaData: any = this.postMetaRepository.createQueryBuilder('pm')
        .where('pm.metaKey = :metaKey', {metaKey: metaKey})
        .andWhere('pm.postId = :postId', {postId: postId})
        .select(['pm.metaValue as value'])
        .getRawOne();

    return metaData?.value;
  }

  async getS3MetaInfoKey(postId: number): Promise<string> {
    let metaValue: any | null = this.getPostMeta(postId, "amazonS3_info");

    if(metaValue) {
      metaValue = unserialize(metaValue);

      if(metaValue?.key) {
        return metaValue.key;
      }
    }

    return "";
  }
}
